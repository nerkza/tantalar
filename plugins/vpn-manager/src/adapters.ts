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
import { chmodSync, closeSync, constants, fchmodSync, lstatSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
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
    const binary = cmd.argv[0];
    const allowed = new Set([
      "cat", "curl", "ip", "nft", "openvpn", "pkill", "resolvconf", "test", "wg", "wg-quick",
    ]);
    if (!binary || !allowed.has(binary)) {
      throw new Error(`privileged command is not allowed: ${JSON.stringify(binary ?? "")}`);
    }
    return new Promise((resolvePromise) => {
      const child = spawn(binary, cmd.argv.slice(1), {
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

export interface WireguardHostPreflight {
  readonly platform: string;
  readonly tools: Readonly<Record<"wg" | "wgQuick" | "ip" | "curl" | "nft" | "resolvconf", boolean>>;
  readonly tunDevice: boolean;
  readonly netAdmin: boolean;
  readonly supported: boolean;
  readonly missing: readonly string[];
  readonly checkedAt: string;
}

function hasNetAdmin(status: string): boolean {
  const match = /^CapEff:\s*([0-9a-f]+)$/im.exec(status);
  if (!match) return false;
  try {
    return (BigInt(`0x${match[1]}`) & (1n << 12n)) !== 0n;
  } catch {
    return false;
  }
}

/** Read-only host checks. Results come from the runtime runner, never a request payload. */
export async function inspectWireguardHost(
  runner: PrivilegedRunner,
  platform: string = process.platform,
): Promise<WireguardHostPreflight> {
  const probes = await Promise.all([
    runner.run({ argv: ["wg", "--version"] }),
    runner.run({ argv: ["wg-quick", "--help"] }),
    runner.run({ argv: ["ip", "-Version"] }),
    runner.run({ argv: ["curl", "--version"] }),
    runner.run({ argv: ["nft", "--version"] }),
    runner.run({ argv: ["resolvconf", "--version"] }),
    runner.run({ argv: ["test", "-c", "/dev/net/tun"] }),
    runner.run({ argv: ["cat", "/proc/self/status"] }),
  ]);
  const present = (index: number): boolean => probes[index]!.code !== 127;
  const tools = {
    wg: present(0),
    wgQuick: present(1),
    ip: present(2),
    curl: present(3),
    nft: present(4),
    resolvconf: present(5),
  } as const;
  const tunDevice = probes[6]!.code === 0;
  const netAdmin = probes[7]!.code === 0 && hasNetAdmin(probes[7]!.stdout);
  const missing: string[] = [];
  if (platform !== "linux") missing.push("linux-host");
  if (!tools.wg) missing.push("wg");
  if (!tools.wgQuick) missing.push("wg-quick");
  if (!tools.ip) missing.push("iproute2");
  if (!tools.curl) missing.push("curl");
  if (!tools.nft) missing.push("nftables");
  if (!tools.resolvconf) missing.push("resolvconf");
  if (!tunDevice) missing.push("/dev/net/tun");
  if (!netAdmin) missing.push("CAP_NET_ADMIN");
  return {
    platform,
    tools,
    tunDevice,
    netAdmin,
    supported: missing.length === 0,
    missing,
    checkedAt: new Date().toISOString(),
  };
}

// ---- Validated profile configuration ---------------------------------------

const WG_INTERFACE_RE = /^[a-zA-Z0-9_-]{1,15}$/; // Linux ifname limit

const WG_HOOK_DIRECTIVES = new Set(["preup", "postup", "predown", "postdown"]);
const WG_DIRECTIVES: Readonly<Record<"Interface" | "Peer", ReadonlySet<string>>> = {
  Interface: new Set(["PrivateKey", "Address", "DNS", "MTU", "Table", "ListenPort", "FwMark"]),
  Peer: new Set(["PublicKey", "PresharedKey", "AllowedIPs", "Endpoint", "PersistentKeepalive"]),
};

function assertPort(value: string, directive: string, minimum = 1): void {
  if (!/^\d{1,5}$/.test(value)) throw new Error(`wireguard ${directive} must be a port number`);
  const port = Number(value);
  if (port < minimum || port > 65_535) throw new Error(`wireguard ${directive} is outside its allowed range`);
}

function assertKey(value: string, directive: string): void {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new Error(`wireguard ${directive} must be a WireGuard key`);
}

function assertCidrList(value: string, directive: string): void {
  const entries = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0) throw new Error(`wireguard ${directive} requires at least one CIDR`);
  for (const entry of entries) {
    const match = /^(.+)\/(\d{1,3})$/.exec(entry);
    const family = match ? isIP(match[1]!) : 0;
    const prefix = match ? Number(match[2]) : -1;
    if (!family || prefix < 0 || prefix > (family === 4 ? 32 : 128)) {
      throw new Error(`wireguard ${directive} contains an invalid CIDR`);
    }
  }
}

function assertEndpoint(value: string): void {
  const ipv6 = /^\[([^\]]+)\]:(\d{1,5})$/.exec(value);
  if (ipv6) {
    if (isIP(ipv6[1]!) !== 6) throw new Error("wireguard Endpoint contains an invalid IPv6 address");
    assertPort(ipv6[2]!, "Endpoint");
    return;
  }
  const host = /^([A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?):(\d{1,5})$/.exec(value);
  if (!host || host[1]!.includes("..")) throw new Error("wireguard Endpoint must be host:port");
  assertPort(host[2]!, "Endpoint");
}

function assertWireguardValue(section: "Interface" | "Peer", key: string, value: string): void {
  if (key === "PrivateKey" || key === "PublicKey" || key === "PresharedKey") return assertKey(value, key);
  if (key === "Address" || key === "AllowedIPs") return assertCidrList(value, key);
  if (key === "DNS") {
    const servers = value.split(",").map((entry) => entry.trim()).filter(Boolean);
    if (servers.length === 0 || servers.some((server) => isIP(server) === 0)) {
      throw new Error("wireguard DNS accepts IP addresses only");
    }
    return;
  }
  if (key === "Endpoint") return assertEndpoint(value);
  if (key === "ListenPort") return assertPort(value, key);
  if (key === "PersistentKeepalive") return assertPort(value, key, 0);
  if (key === "MTU") {
    if (!/^\d{3,5}$/.test(value) || Number(value) < 576 || Number(value) > 65_535) {
      throw new Error("wireguard MTU is outside its allowed range");
    }
    return;
  }
  if (key === "Table") {
    if (value === "auto") return;
    if (!/^\d{1,10}$/.test(value) || Number(value) < 1 || Number(value) > 4_294_967_295) {
      throw new Error("wireguard Table must be auto or a numeric routing table");
    }
    return;
  }
  if (key === "FwMark" && !/^(?:0x[0-9a-fA-F]{1,8}|\d{1,10})$/.test(value)) {
    throw new Error("wireguard FwMark must be numeric");
  }
  if (key === "FwMark" && !value.startsWith("0x") && Number(value) > 4_294_967_295) {
    throw new Error("wireguard FwMark is outside its allowed range");
  }
  void section;
}

/**
 * Parse the small wg-quick subset Tantalar can reason about safely.
 *
 * wg-quick deliberately supports shell hooks. A profile is untrusted input,
 * so accepting those hooks would turn a later privileged Apply into command
 * execution. Unknown directives fail closed for the same reason.
 */
function assertSafeWireguardConfig(configText: string): void {
  let section: "Interface" | "Peer" | null = null;
  let interfaceCount = 0;
  let peerCount = 0;
  let interfaceHasPrivateKey = false;
  let peerHasPublicKey = false;
  let peerHasAllowedIps = false;

  const finishPeer = (): void => {
    if (section === "Peer" && !peerHasPublicKey) {
      throw new Error("wireguard peer missing PublicKey");
    }
    if (section === "Peer" && !peerHasAllowedIps) {
      throw new Error("wireguard peer missing AllowedIPs");
    }
  };

  for (const [index, rawLine] of configText.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith(";")) continue;

    const sectionMatch = /^\[([^\]]+)\]$/.exec(line);
    if (sectionMatch) {
      finishPeer();
      const name = sectionMatch[1];
      if (name !== "Interface" && name !== "Peer") {
        throw new Error(`wireguard section ${JSON.stringify(name)} is not supported`);
      }
      section = name;
      if (name === "Interface") {
        if (peerCount > 0) throw new Error("wireguard [Interface] must appear before [Peer]");
        interfaceCount += 1;
        if (interfaceCount > 1) throw new Error("wireguard profile must contain one [Interface] section");
      } else {
        if (interfaceCount !== 1) throw new Error("wireguard [Interface] must appear before [Peer]");
        peerCount += 1;
        peerHasPublicKey = false;
        peerHasAllowedIps = false;
      }
      continue;
    }

    if (!section) throw new Error(`wireguard directive before section at line ${index + 1}`);
    const assignment = /^([A-Za-z][A-Za-z0-9]*)\s*=\s*(.+)$/.exec(line);
    if (!assignment) throw new Error(`invalid wireguard directive at line ${index + 1}`);
    const key = assignment[1]!;
    const value = assignment[2]!.trim();
    if (WG_HOOK_DIRECTIVES.has(key.toLowerCase())) {
      throw new Error(`wireguard command hook ${key} is forbidden`);
    }
    if (!WG_DIRECTIVES[section].has(key)) {
      throw new Error(`wireguard directive ${key} is not supported in [${section}]`);
    }
    if (value.length === 0) throw new Error(`wireguard directive ${key} requires a value`);
    assertWireguardValue(section, key, value);
    if (section === "Interface" && key === "PrivateKey") interfaceHasPrivateKey = true;
    if (section === "Peer" && key === "PublicKey") peerHasPublicKey = true;
    if (section === "Peer" && key === "AllowedIPs") peerHasAllowedIps = true;
  }

  finishPeer();
  if (interfaceCount !== 1) throw new Error("wireguard profile missing [Interface]");
  if (!interfaceHasPrivateKey) throw new Error("wireguard interface missing PrivateKey");
  if (peerCount === 0) throw new Error("wireguard profile must contain at least one [Peer]");
}

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
  // validation here rejects every directive outside the reviewed subset.
  if (raw.protocol === "wireguard") {
    assertSafeWireguardConfig(configText);
    return { protocol: "wireguard", profileId, configText };
  }
  if (raw.protocol === "openvpn") {
    // OpenVPN permits scripts, plugins and management directives. It remains
    // read-only metadata until Tantalar has an equivalent strict parser and
    // real-host teardown/leak evidence.
    throw new Error("openvpn apply is disabled in this build");
  }
  throw new Error(`unsupported vpn protocol ${String(raw.protocol ?? "")}`);
}

/**
 * Write a profile file into the managed state dir with safe permissions.
 * Returns the absolute path. Never logs content.
 */
export function writeProfileFile(stateDir: string, profile: ProfileConfig): string {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const state = lstatSync(stateDir);
  if (!state.isDirectory() || state.isSymbolicLink()) throw new Error("vpn state path must be a real directory");
  chmodSync(stateDir, 0o700);
  const ext = profile.protocol === "wireguard" ? ".conf" : ".ovpn";
  const path = join(stateDir, `${profile.profileId}${ext}`);
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, profile.configText, { encoding: "utf8" });
    fchmodSync(fd, 0o600); // enforce even under umask surprises
  } finally {
    closeSync(fd);
  }
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
    await this.assertRoutePinned(profilePath);
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
  private async assertRoutePinned(profilePath: string): Promise<void> {
    const argv = ["ip", "route", "show", "dev", this.interfaceName];
    const result = await this.runner.run({ argv });
    assertOk(result, argv);
    if (result.stdout.trim().length === 0) {
      // No route => bring it straight back down; nothing may retry through it.
      await this.down(profilePath).catch(() => undefined);
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
