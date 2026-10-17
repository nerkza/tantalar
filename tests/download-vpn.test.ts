import { describe, expect, it } from "vitest";
import { DownloadVpn, parseDownloadVpnProfile, VPN_CLIENTS, VPN_PLUGIN } from "../apps/server/src/download-vpn.js";

const profile = `[Interface]\nPrivateKey = ${"A".repeat(43)}=\nAddress = 10.72.0.2/32\nDNS = 10.72.0.1\n[Peer]\nPublicKey = ${"B".repeat(43)}=\nEndpoint = 192.0.2.1:51820\nAllowedIPs = 0.0.0.0/0\n`;
describe("download-only VPN", () => {
  it("keeps legacy protection required when its profile needs replacement", async () => {
    const vpn = new DownloadVpn({ stateDir: "/tmp/test-vpn", platform: "darwin", restartClient: async () => {},
      documents: { get: async () => null, put: async () => {} }, secrets: { get: async () => null, set: async () => {} } });
    await vpn.initialize({ bindings: [{ clientId: VPN_CLIENTS[0], profileId: "legacy" }], profiles: [{ profileId: "legacy", protocol: "wireguard", configText: profile.replace("DNS = 10.72.0.1", "") }] });
    expect(await vpn.invoke("pre-dispatch-check", { clientId: VPN_CLIENTS[0] })).toMatchObject({ allowDispatch: false, profileId: "legacy" });
  });
  it("accepts provider profiles and rejects incomplete, executable, or split routes", () => {
    expect(parseDownloadVpnProfile(profile).dns).toEqual(["10.72.0.1"]);
    for (const invalid of [profile.replace("DNS = 10.72.0.1", ""), profile.replace("0.0.0.0/0", "192.0.2.0/24"), profile + "PostUp = echo unsafe\n", profile.replace("Address =", "Table = off\nAddress ="), profile.replace("DNS =", "DNS = 10.72.0.1\nDNS =")]) {
      expect(() => parseDownloadVpnProfile(invalid)).toThrow();
    }
  });
  it("restores required intent and blocks unsupported hosts instead of returning a direct command", async () => {
    const vpn = new DownloadVpn({ stateDir: "/tmp/test-vpn", platform: "darwin", restartClient: async () => {},
      documents: { get: async (owner, key) => owner === VPN_PLUGIN && key === "download-vpn-v1" ? { doc: { version: 1, bindings: { [VPN_CLIENTS[0]]: "required" }, profiles: [] } } : null, put: async () => {} },
      secrets: { get: async () => null, set: async () => {} } });
    await vpn.initialize();
    await expect(vpn.prepareEntry(VPN_CLIENTS[0], { command: "node", args: [], env: {} })).rejects.toThrow("Direct fallback is disabled");
    expect(await vpn.invoke("pre-dispatch-check", { clientId: VPN_CLIENTS[0] })).toMatchObject({ allowDispatch: false });
    expect(await vpn.prepareEntry("dev.tantalar.plugin.serving", { command: "node", args: [], env: {} })).toMatchObject({ command: "node" });
    await expect(vpn.invoke("disconnect", { clientId: VPN_CLIENTS[0] })).rejects.toThrow("Confirm");
  });
});
