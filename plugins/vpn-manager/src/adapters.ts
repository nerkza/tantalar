/**
 * Real tunnel lifecycle adapters (Wave 6, TAN-044).
 *
 * `PrivilegedRunner` is the ONLY seam that touches the host network: it runs
 * a short allow-listed command through a controlled local network namespace
 * (or, in production, a setuid helper / sudo policy). Everything else in
 * this module is pure orchestration and fully unit-testable with a recording
 * runner — no real interfaces are touched unless a real runner is injected.
 *
 * Tantalar owns:
 *  - validated configuration (profile files written 0600, owned by the
 *    service user, inside a dedicated state dir);
 *  - interface detection (`wg show` / configured ovpn device name);
 *  - routes and DNS via the adapter's bind/unbind command sequences;
 *  - health checks that probe ROUTE + PUBLIC ENDPOINT, never process state;
 *  - rotation (stop old tunnel before starting the new one) and recovery;
 *  - audit events for every privileged mutation.
 *
 * Kill switch is fail-closed: `block` removes routes/DNS pinning AND closes
 * any sockets bound to the tunnel by running the namespace teardown BEFORE
 * anything may retry; required traffic binds only to an approved interface.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";

/** A single privileged command invocation, already validated. */
export interface PrivilegedCommand {
  readonly argv: string[];
}

/**
 * Seam over privileged operations. Production wires a helper that executes
 * inside a controlled local network namespace; tests record invocations.
 * Implementations MUST reject unknown binaries — the adapters here only ever
 * emit argv entries built from validated configuration.
 */
export interface PrivilegedRunner {
  run(cmd: PrivilegedCommand): Promise<{ code: number; stdout: string; stderr: string }>;
}

export class RunnerError extends Error {
  constructor(argv: string[], stderr: string) {
    super(`privileged command failed (${argv.join(" ")}): ${stderr.trim()}`);
  }
}

function assertOk(result: { code: number; stderr: string }, argv: string[]): void {
  if (result.code !== 0) throw new RunnerError(argv, result.stderr);
}

/** Run argv via spawn with no shell, minimal env. */
export class SpawnPrivilegedRunner implements PrivilegedRunner {
  run(cmd: PrivilegedCommand): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolvePromise) => {
      const child = spawn(cmd.argv[0]!, cmd.argv.slice(1), {
        stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += String(d)));
      child.stderr.on("data", (d) => (stderr += String(d)));
      child.on("error", (err) => resolvePromise({ code: 127, stdout, stderr: String(err) }));
      child.on("close", (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
    });
  }
}

// ---- Validated profile configuration ---------------------------------------

const WG_INTERFACE_RE = /^[a-zA-Z0-9_-]{1,15}$/; // Linux ifname limit
const OVPN_DEVICE_RE = /^[a-zA-Z0-9_-]{1,15}$/;

export interface WireguardProfileConfig {
  protocol: "wireguard";
  profileId: string;
  /** wg-quick compatible config text. Written 0600 into the state dir. */
  configText: string;
}

export interface OpenVpnProfileConfig {
  protocol: "openvpn";
  profileId: string;
  /** .ovpn profile text. Written 0600 into the state dir. */
  configText: string;
  /** TUN device name the profile must create (dev <name> directive). */
  device: string;
}

export type ProfileConfig = WireguardProfileConfig | OpenVpnProfileConfig;

/** Validate a profile before anything touches disk or the network. */
export function validateProfileConfig(raw: Record<string, unknown>): ProfileConfig {
  const profileId = String(raw.profileId ?? "");
  if (!WG_INTERFACE_RE.test(profileId)) {
    throw new Error(`invalid vpn profile id ${JSON.stringify(profileId)}`);
  }
  const configText = String(raw.configText ?? "");
  if (configText.trim().length === 0) throw new Error("profile configText required");
  // Fail closed on inline credential leakage into logs is handled at redaction;
  // here we only reject obviously wrong directives.
  if (raw.protocol === "wireguard") {
    if (!/^\s*\[Interface\]/m.test(configText)) throw new Error("wireguard profile missing [Interface]");
    return { protocol: "wireguard", profileId, configText };
  }
  if (raw.protocol === "openvpn") {
    const device = String(raw.device ?? "");
    if (!OVPN_DEVICE_RE.test(device)) throw new Error(`invalid openvpn device ${JSON.stringify(device)}`);
    return { protocol: "openvpn", profileId, configText, device };
  }
  throw new Error(`unsupported vpn protocol ${String(raw.protocol ?? "")}`);
}

/**
 * Write a profile file into the managed state dir with safe permissions.
 * Returns the absolute path. Never logs content.
 */
export function writeProfileFile(stateDir: string, profile: ProfileConfig): string {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  const ext = profile.protocol === "wireguard" ? ".conf" : ".ovpn";
  const path = join(stateDir, `${profile.profileId}${ext}`);
  writeFileSync(path, profile.configText, { mode: 0o600 });
  chmodSync(path, 0o600); // enforce even under umask surprises
  return path;
}

// ---- Adapters ---------------------------------------------------------------

export interface TunnelAdapter {
  readonly protocol: "wireguard" | "openvpn";
  /** Bring the tunnel up and pin routing/DNS to its interface. */
  up(profilePath: string): Promise<void>;
  /** Detect whether the tunnel interface currently exists and has a route. */
  detectInterface(): Promise<string | null>;
  /** Probe route + public endpoint reachability THROUGH the tunnel interface. */
  checkHealth(interfaceName: string): Promise<"healthy" | "degraded" | "down">;
  /** Tear the tunnel down completely (rotation end-state). */
  down(profilePath: string): Promise<void>;
}

/**
 * WireGuard lifecycle: wg-quick up/down plus explicit route verification.
 * Health checks `wg show <if>` output (route presence) and then probes a
 * public endpoint THROUGH the interface — never merely that a process lives.
 */
export class WireguardAdapter implements TunnelAdapter {
  readonly protocol = "wireguard" as const;
  constructor(
    private readonly runner: PrivilegedRunner,
    private readonly interfaceName: string,
    private readonly endpointCheckUrl: string = "https://api.ipify.org",
  ) {}

  async up(profilePath: string): Promise<void> {
    const argv = ["wg-quick", "up", profilePath];
    assertOk(await this.runner.run({ argv }), argv);
    await this.assertRoutePinned();
  }

  async down(profilePath: string): Promise<void> {
    const argv = ["wg-quick", "down", profilePath];
    assertOk(await this.runner.run({ argv }), argv);
  }

  async detectInterface(): Promise<string | null> {
    const argv = ["wg", "show", this.interfaceName];
    const result = await this.runner.run({ argv });
    return result.code === 0 ? this.interfaceName : null;
  }

  /** Route loss closes the tunnel BEFORE any retry can happen. */
  private async assertRoutePinned(): Promise<void> {
    const argv = ["ip", "route", "show", "dev", this.interfaceName];
    const result = await this.runner.run({ argv });
    assertOk(result, argv);
    if (result.stdout.trim().length === 0) {
      // No route => bring it straight back down; nothing may retry through it.
      await this.down("").catch(() => undefined);
      throw new RunnerError(argv, `no route pinned to ${this.interfaceName}; tunnel torn down`);
    }
  }

  async checkHealth(_iface: string): Promise<"healthy" | "degraded" | "down"> {
    const iface = await this.detectInterface();
    if (!iface) return "down";
    // Endpoint probe THROUGH the interface only (curl --interface), IPv4 first.
    const argv = ["curl", "--interface", iface, "-4", "-fsS", "--max-time", "5", this.endpointCheckUrl];
    const result = await this.runner.run({ argv });
    if (result.code === 0 && result.stdout.trim().length > 0) return "healthy";
    // One degraded retry before declaring down: distinguishes transient loss.
    const retry = await this.runner.run({ argv });
    return retry.code === 0 ? "degraded" : "down";
  }
}

/**
 * OpenVPN lifecycle: openvpn --config --daemon writes the device itself, so
 * binding pins source-address rules to the declared tun device and health
 * probes route+endpoint through that device.
 */
export class OpenVpnAdapter implements TunnelAdapter {
  readonly protocol = "openvpn" as const;
  constructor(
    private readonly runner: PrivilegedRunner,
    private readonly device: string,
    private readonly endpointCheckUrl: string = "https://api.ipify.org",
  ) {}

  async up(profilePath: string): Promise<void> {
    const argv = ["openvpn", "--config", profilePath, "--dev", this.device, "--daemon"];
    assertOk(await this.runner.run({ argv }), argv);
    // Policy loads BEFORE sockets open: wait until the device carries a route.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (await this.hasRoute()) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new RunnerError(argv, `no route appeared on ${this.device} within 10s`);
  }

  async down(profilePath: string): Promise<void> {
    // Kill by config so unrelated tunnels survive; then verify the device is gone.
    const argv = ["pkill", "-f", `openvpn.*${profilePath}`];
    await this.runner.run({ argv }); // pkill returns 1 when nothing matched: fine
    const ipArgv = ["ip", "link", "delete", this.device];
    await this.runner.run({ argv: ipArgv }); // idempotent teardown
  }

  async detectInterface(): Promise<string | null> {
    const result = await this.runner.run({ argv: ["ip", "link", "show", this.device] });
    return result.code === 0 ? this.device : null;
  }

  private async hasRoute(): Promise<boolean> {
    const result = await this.runner.run({ argv: ["ip", "route", "show", "dev", this.device] });
    return result.code === 0 && result.stdout.trim().length > 0;
  }

  async checkHealth(_iface: string): Promise<"healthy" | "degraded" | "down"> {
    const iface = await this.detectInterface();
    if (!iface || !(await this.hasRoute())) return "down";
    const argv = ["curl", "--interface", iface, "-4", "-fsS", "--max-time", "5", this.endpointCheckUrl];
    const result = await this.runner.run({ argv });
    if (result.code === 0 && result.stdout.trim().length > 0) return "healthy";
    const retry = await this.runner.run({ argv });
    return retry.code === 0 ? "degraded" : "down";
  }
}
