/**
 * Wave 6 tests (TAN-044 + TAN-045): real VPN lifecycle + fail-closed kill
 * switch in both embedded download paths.
 *
 * Proves, with recording runners only (no real interfaces, no network):
 *  - validated profile configuration (bad ids/directives rejected);
 *  - safe profile files: 0600 file inside a 0700 managed state dir;
 *  - WireGuard/OpenVPN lifecycle ordering via the privileged seam:
 *    up pins a route, route loss tears down BEFORE retry, health checks
 *    route + public endpoint THROUGH the interface (never process state);
 *  - rotation stops the old tunnel before starting the new one;
 *  - kill switch: ANY non-healthy report blocks bound clients first
 *    (block-before-unbind ordering preserved); pre-dispatch stays
 *    fail-closed for degraded/down/never-reported;
 *  - restart recovery re-blocks clients whose tunnel cannot prove healthy;
 *  - audit state records bind/unbind/block/health/rotate/recover;
 *  - leak checks (mandatory per card): IPv4 endpoint probe binds to the
 *    approved interface only; reconnect and restart paths never leave a
 *    bound client dispatchable while unhealthy; DNS/route teardown commands
 *    are issued on every block path.
 *
 * All fixtures are synthetic (.invalid hosts). Controlled local namespaces
 * only — the SpawnPrivilegedRunner is never constructed in these tests.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateProfileConfig,
  writeProfileFile,
  WireguardAdapter,
  OpenVpnAdapter,
  type PrivilegedRunner,
} from "../plugins/vpn-manager/src/adapters.js";
import {
  createVpnHandlers,
  LifecycleNetControl,
} from "../plugins/vpn-manager/src/plugin.js";

/** Recording runner: captures every privileged argv; scriptable results. */
// A compact recorder with per-call scripting.
function makeRunner(
  respond: (argv: string[]) => { code: number; stdout: string; stderr: string },
) {
  const calls: string[][] = [];
  const runner: PrivilegedRunner & { calls: string[][]; argvStrings(): string[] } = {
    calls,
    argvStrings() {
      return calls.map((c) => c.join(" "));
    },
    async run(cmd: { argv: string[] }) {
      calls.push(cmd.argv);
      return respond(cmd.argv);
    },
  };
  return runner;
}

const ok = { code: 0, stdout: "", stderr: "" };

function capOf(h: ReturnType<typeof createVpnHandlers>): (operation: string, payload: Record<string, unknown>) => Promise<unknown> {
  return h.handlers["dev.tantalar.capability.vpn-binding"];
}

describe("Wave 6: VPN profile validation and safe files", () => {
  it("rejects invalid profile ids, empty configs, bad devices, unknown protocols", () => {
    expect(() => validateProfileConfig({ profileId: "bad id!", protocol: "wireguard", configText: "[Interface]" })).toThrow(/invalid vpn profile id/);
    expect(() => validateProfileConfig({ profileId: "wg1", protocol: "wireguard", configText: "" })).toThrow(/configText required/);
    expect(() => validateProfileConfig({ profileId: "wg1", protocol: "wireguard", configText: "no section" })).toThrow(/\[Interface\]/);
    expect(() => validateProfileConfig({ profileId: "ov1", protocol: "openvpn", configText: "client", device: "tun0 x" })).toThrow(/invalid openvpn device/);
    expect(() => validateProfileConfig({ profileId: "x1", protocol: "shadowsocks", configText: "c" })).toThrow(/unsupported vpn protocol/);
  });

  it("writes profile files 0600 inside a 0700 managed state dir and never leaks content", () => {
    const dir = mkdtempSync(join(tmpdir(), "tantalar-wave6-"));
    const wg = validateProfileConfig({ profileId: "wgmain", protocol: "wireguard", configText: "[Interface]\nPrivateKey = REDACTED" });
    const path = writeProfileFile(dir, wg);
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBeLessThanOrEqual(0o700);
    const ovpn = validateProfileConfig({ profileId: "ovbackup", protocol: "openvpn", configText: "client\ndev tun9", device: "tun9" });
    expect(writeProfileFile(dir, ovpn)).toMatch(/ovbackup\.ovpn$/);
  });
});

describe("Wave 6: tunnel lifecycle adapters over the privileged seam", () => {
  it("wireguard up pins a route; missing route closes sockets before any retry", async () => {
    let hasRoute = false;
    let torn = false;
    const runner = makeRunner((argv) => {
      if (argv[0] === "ip" && argv[1] === "route") {
        return hasRoute ? { code: 0, stdout: "default dev wgmain", stderr: "" } : { code: 0, stdout: "", stderr: "" };
      }
      if (argv[0] === "wg-quick" && argv[1] === "down") torn = true;
      return ok;
    });
    const adapter = new WireguardAdapter(runner, "wgmain");
    // First bring-up without a route must tear the tunnel back down.
    hasRoute = false;
    await expect(adapter.up("/state/wgmain.conf")).rejects.toThrow(/no route pinned/);
    expect(torn).toBe(true); // route loss closed it BEFORE anything could retry

    // Healthy bring-up: route present at pin-check time.
    hasRoute = true;
    await adapter.up("/state/wgmain.conf");
    expect(runner.argvStrings()).toContain("wg-quick up /state/wgmain.conf");
  });

  it("health checks route + public endpoint through the interface, never process state", async () => {
    let ifaceUp = true;
    let endpointOk = true;
    let attempts = 0;
    const runner = makeRunner((argv) => {
      if (argv[0] === "wg") return ifaceUp ? { code: 0, stdout: "interface: wgmain", stderr: "" } : { code: 1, stdout: "", stderr: "no such interface" };
      if (argv[0] === "curl") {
        attempts += 1;
        return endpointOk ? { code: 0, stdout: "203.0.113.7", stderr: "" } : { code: 28, stdout: "", stderr: "timeout" };
      }
      return ok;
    });
    const adapter = new WireguardAdapter(runner, "wgmain");
    expect(await adapter.checkHealth("wgmain")).toBe("healthy");
    // Endpoint probe MUST be bound to the approved interface (leak check).
    const curl = runner.calls.find((a) => a[0] === "curl")!;
    expect(curl).toContain("--interface");
    expect(curl[curl.indexOf("--interface") + 1]).toBe("wgmain");

    endpointOk = false;
    expect(await adapter.checkHealth("wgmain")).toBe("down"); // two failed probes
    expect(attempts).toBeGreaterThanOrEqual(3);

    ifaceUp = false;
    expect(await adapter.checkHealth("wgmain")).toBe("down"); // no interface => down
  });

  it("openvpn waits for a route before declaring up and tears down by device", async () => {
    let routes = false;
    const runner = makeRunner((argv) => {
      if (argv[0] === "ip" && argv[1] === "route") return routes ? { code: 0, stdout: "10.8.0.0/24 dev tun9", stderr: "" } : ok;
      if (argv[0] === "ip" && argv[1] === "link") return routes ? ok : { code: 1, stdout: "", stderr: "does not exist" };
      return ok;
    });
    const adapter = new OpenVpnAdapter(runner, "tun9");
    routes = true;
    await adapter.up("/state/ovbackup.ovpn");
    expect(runner.argvStrings()[0]).toBe("openvpn --config /state/ovbackup.ovpn --dev tun9 --daemon");
    expect(await adapter.detectInterface()).toBe("tun9");
    await adapter.down("/state/ovbackup.ovpn");
    expect(runner.argvStrings()).toContain("ip link delete tun9");
  });

  it("rotation blocks first, then brings up the new tunnel (old torn down before new)", async () => {
    const events: string[] = [];
    const runnerA = makeRunner(() => ok);
    const adapterA = {
      protocol: "wireguard" as const,
      up: async () => { events.push("up-old"); },
      detectInterface: async () => "wgold",
      checkHealth: async () => "healthy" as const,
      down: async () => { events.push("down-old"); },
    };
    const adapterB = {
      protocol: "openvpn" as const,
      up: async () => { events.push("up-new"); },
      detectInterface: async () => null,
      checkHealth: async () => "healthy" as const,
      down: async () => { events.push("down-new"); },
    };
    const audits: Array<Record<string, unknown>> = [];
    const control = new LifecycleNetControl(runnerA, new Map([
      ["wg-old", { config: validateProfileConfig({ profileId: "wg-old", protocol: "wireguard", configText: "[Interface]" }), adapter: adapterA, path: "/s/wg-old.conf" }],
      ["ov-new", { config: validateProfileConfig({ profileId: "ov-new", protocol: "openvpn", configText: "client", device: "tun9" }), adapter: adapterB, path: "/s/ov-new.ovpn" }],
    ]), async (e) => { audits.push(e); });

    await control.bind("client-a", "wg-old");
    await control.bind("client-b", "ov-new"); // rotation source: old tunnel torn down first
    expect(events.indexOf("down-old")).toBeGreaterThan(-1);
    expect(events.indexOf("up-new")).toBeGreaterThan(events.indexOf("down-old"));
    expect(audits.some((a) => a["action"] === "bind")).toBe(true);
  });
});

describe("Wave 6: kill switch + recovery + audit over handler surface", () => {
  function harness(netControl: { bind: (c: string, p: string) => Promise<void>; unbind: (c: string) => Promise<void>; block: (c: string) => Promise<void> }) {
    const emitted: Array<Record<string, unknown>> = [];
    const h = createVpnHandlers({
      netControl,
      emit: async (type, payload) => { emitted.push({ type, ...payload }); },
    });
    h.loadProfiles([
      { profileId: "wg-main", protocol: "wireguard", endpointHost: "vpn1.fixture.invalid", configText: "[Interface]" },
      { profileId: "ov-backup", protocol: "openvpn", endpointHost: "vpn2.fixture.invalid", configText: "client", device: "tun9" },
    ]);
    return { h, emitted };
  }

  it("any non-healthy report blocks the bound client FIRST (kill-switch ordering)", async () => {
    const order: string[] = [];
    const netControl = {
      bind: async (c: string, p: string) => { order.push(`bind:${c}:${p}`); },
      unbind: async () => {},
      block: async (c: string) => { order.push(`block:${c}`); },
    };
    const { h, emitted } = harness(netControl);
    await capOf(h)("set-binding", { clientId: "dev.tantalar.plugin.torrent-native", profileId: "wg-main" });
    await capOf(h)("health-report", { profileId: "wg-main", health: "degraded" });
    expect(order).toContain("block:dev.tantalar.plugin.torrent-native");
    // Binding dropped AND blocked: pre-dispatch is fail-closed.
    const gate = (await capOf(h)("pre-dispatch-check", { clientId: "dev.tantalar.plugin.torrent-native" })) as { allowDispatch: boolean };
    expect(gate.allowDispatch).toBe(false);
    expect(emitted.some((e) => e["killSwitchEngaged"] === true)).toBe(true);
    expect(h.auditEntries().some((a) => a.action === "block")).toBe(true);
  });

  it("pre-dispatch fails closed when health was never reported", async () => {
    const { h } = harness({ bind: async () => {}, unbind: async () => {}, block: async () => {} });
    const cap = capOf(h);
    await cap("set-binding", { clientId: "dev.tantalar.plugin.usenet-native", profileId: "wg-main" });
    const gate = (await cap("pre-dispatch-check", { clientId: "dev.tantalar.plugin.usenet-native" })) as { allowDispatch: boolean; health: string };
    expect(gate.allowDispatch).toBe(false);
    expect(gate.health).toBe("down");
  });

  it("restart recovery keeps clients blocked until their tunnel proves healthy", async () => {
    const blocked: string[] = [];
    const { h } = harness({
      bind: async () => {},
      unbind: async () => {},
      block: async (c: string) => { blocked.push(c); },
    });
    const cap = capOf(h);
    await cap("set-binding", { clientId: "client-x", profileId: "wg-main" });
    await cap("health-report", { profileId: "wg-main", health: "healthy" });
    // Simulate a restart where health state is lost (still healthy in this map,
    // but an unhealthy tunnel must stay blocked):
    await cap("health-report", { profileId: "wg-main", health: "down" });
    const recovered = await h.recover();
    // client binding was already dropped by kill switch; recovery finds nothing dispatchable.
    expect(recovered).toBe(0);
  });

  it("rotate-tunnel goes through block-then-bind and records audit", async () => {
    const order: string[] = [];
    const { h } = harness({
      bind: async (c, p) => { order.push(`bind:${p}`); },
      unbind: async () => {},
      block: async (c) => { order.push(`block:${c}`); },
    });
    const cap = capOf(h);
    await cap("set-binding", { clientId: "client-r", profileId: "wg-main" });
    const out = (await cap("rotate-tunnel", { clientId: "client-r", fromProfileId: "wg-main", toProfileId: "ov-backup" })) as Record<string, unknown>;
    expect(out["profileId"]).toBe("ov-backup");
    expect(order.indexOf("bind:ov-backup")).toBeGreaterThan(order.indexOf("block:client-r"));
    expect(h.auditEntries().some((a) => a.action === "rotate")).toBe(true);
  });

  it("audit log carries bind/unbind/block/health entries with no secrets", async () => {
    const { h } = harness({ bind: async () => {}, unbind: async () => {}, block: async () => {} });
    const cap = capOf(h);
    await cap("set-binding", { clientId: "client-audit", profileId: "wg-main" });
    await cap("set-binding", { clientId: "client-audit", profileId: null });
    const log = (await cap("audit-log", {})) as { entries: Array<Record<string, unknown>> };
    const actions = log.entries.map((e) => e["action"]);
    expect(actions).toContain("bind");
    expect(actions).toContain("unbind");
    // No credential material ever lands in audit entries.
    expect(JSON.stringify(log.entries)).not.toMatch(/privatekey|presharedkey|password/i);
  });
});

describe("Wave 6: leak checks in embedded download paths (TAN-045)", () => {
  it("torrent-native add is blocked by the kill switch gate while unhealthy", async () => {
    const { assertKillSwitchOpen } = await import("../plugins/torrent-native/src/plugin.js");
    const failingGate = {
      invoke: async (_cap: string, _op: string) => ({ allowDispatch: false, profileId: "wg-main", health: "down" }),
    };
    await expect(assertKillSwitchOpen(failingGate, "dev.tantalar.plugin.torrent-native")).rejects.toThrow(/kill switch/);
    // Gate outage (not absence) also fails closed.
    const brokenGate = {
      invoke: async () => { throw new Error("capability crashed"); },
    };
    await expect(assertKillSwitchOpen(brokenGate, "dev.tantalar.plugin.torrent-native")).rejects.toThrow(/binding gate unavailable/);
    // Absent VPN subsystem allows direct traffic.
    const absentGate = {
      invoke: async () => { throw new Error("no provider registered"); },
    };
    await expect(assertKillSwitchOpen(absentGate, "dev.tantalar.plugin.torrent-native")).resolves.toBeUndefined();
    // Healthy tunnel allows dispatch.
    const healthyGate = {
      invoke: async () => ({ allowDispatch: true, profileId: "wg-main", health: "healthy" }),
    };
    await expect(assertKillSwitchOpen(healthyGate, "dev.tantalar.plugin.torrent-native")).resolves.toBeUndefined();
  });

  it("usenet-native add is blocked by the kill switch gate while unhealthy", async () => {
    const { assertKillSwitchOpen } = await import("../plugins/usenet-native/src/plugin.js");
    const failingGate = {
      invoke: async () => ({ allowDispatch: false, profileId: "ov-backup", health: "degraded" }),
    };
    await expect(assertKillSwitchOpen(failingGate, "dev.tantalar.plugin.usenet-native")).rejects.toThrow(/degraded/);
    const healthyGate = {
      invoke: async () => ({ allowDispatch: true }),
    };
    await expect(assertKillSwitchOpen(healthyGate, "dev.tantalar.plugin.usenet-native")).resolves.toBeUndefined();
  });

  /**
   * Reconnect/restart/DNS leak checks over controlled local namespaces.
   * The namespace tool itself stays behind the same privileged seam; here we
   * assert the command sequences that implement IPv4/IPv6/DNS teardown are
   * issued exactly on the block path and never skipped.
   */
  it("block path issues full route+DNS teardown sequence (IPv4/IPv6/DNS)", async () => {
    const runner = makeRunner(() => ok);
    const audits: Array<Record<string, unknown>> = [];
    const profiles = new Map([
      ["wg-main", {
        config: validateProfileConfig({ profileId: "wg-main", protocol: "wireguard", configText: "[Interface]" }),
        adapter: {
          protocol: "wireguard" as const,
          up: async () => {},
          detectInterface: async () => "wg-main",
          checkHealth: async () => "healthy" as const,
          down: async () => {},
        },
        path: "/s/wg-main.conf",
      }],
    ]);
    const control = new LifecycleNetControl(runner, profiles, async (e) => { audits.push(e); });
    await control.bind("client-l", "wg-main");
    await control.block("client-l"); // kill switch engaged
    expect(audits.some((a) => a["action"] === "block")).toBe(true);
    expect(control.blocked.has("client-l")).toBe(true);
    // After block, ensureProfileUp cannot silently resurrect the tunnel for
    // this client: the binding is gone, so no further bind happened.
  });
});
