import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { SpawnPrivilegedRunner, validateProfileConfig, type PrivilegedRunner } from "dev.tantalar.plugin.vpn-manager/adapters";
import type { SecretStore } from "./secret-store.js";

export const VPN_PLUGIN = "dev.tantalar.plugin.vpn-manager";
export const VPN_CONTROL = "dev.tantalar.capability.vpn.network-control";
export const VPN_CLIENTS = ["dev.tantalar.plugin.torrent-native", "dev.tantalar.plugin.usenet-native"] as const;
const STATE_KEY = "download-vpn-v1";
const PROFILE_ID = /^[a-zA-Z0-9_-]{1,15}$/;

interface VpnState {
  version: 1;
  bindings: Record<string, string>;
  profiles: Array<{ profileId: string; protocol: "wireguard"; endpointHost: string }>;
}
type Entry = { command: string; args: string[]; env: Record<string, string> };
interface Options {
  stateDir: string;
  documents: {
    get(owner: string, key: string): Promise<{ doc: unknown } | null>;
    put(owner: string, key: string, doc: unknown): Promise<void>;
  };
  secrets: Pick<SecretStore, "get" | "set">;
  restartClient(clientId: string): Promise<unknown>;
  runner?: PrivilegedRunner;
  platform?: string;
  netnsConfigDir?: string;
}

/** Only the full-tunnel, single-peer profile subset that this runtime enforces. */
export function parseDownloadVpnProfile(text: string) {
  if (typeof text !== "string" || text.length > 65_536) throw new Error("Upload a WireGuard profile smaller than 64 KiB.");
  validateProfileConfig({ profileId: "validation", protocol: "wireguard", configText: text });
  const fields = new Map<string, string>();
  let section = "";
  let peers = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[")) { section = line; if (line === "[Peer]") peers++; continue; }
    const equal = line.indexOf("=");
    const key = line.slice(0, equal).trim();
    const value = line.slice(equal + 1).trim();
    const allowed = section === "[Interface]" ? ["PrivateKey", "Address", "DNS", "MTU"] : ["PublicKey", "PresharedKey", "Endpoint", "AllowedIPs", "PersistentKeepalive"];
    if (!allowed.includes(key)) throw new Error(`Remove ${key} from the profile. Tantalar manages namespace routing.`);
    if (fields.has(key)) throw new Error(`Use one ${key} entry in the WireGuard profile.`);
    fields.set(key, value);
  }
  if (peers !== 1) throw new Error("Use a WireGuard profile with one VPN peer.");
  const addresses = (fields.get("Address") ?? "").split(",").map(value => value.trim()).filter(Boolean);
  const dns = (fields.get("DNS") ?? "").split(",").map(value => value.trim()).filter(Boolean);
  const routes = (fields.get("AllowedIPs") ?? "").split(",").map(value => value.trim());
  if (!addresses.some(address => isIP(address.split("/")[0]!) === 4)) throw new Error("The profile needs an IPv4 Address from your VPN provider.");
  if (!dns.length || dns.some(address => !isIP(address))) throw new Error("Add the VPN provider's DNS IP address to the profile.");
  if (!routes.includes("0.0.0.0/0") || routes.some(route => !["0.0.0.0/0", "::/0"].includes(route))) throw new Error("Use a full-tunnel profile: AllowedIPs must contain 0.0.0.0/0 and optionally ::/0.");
  const endpoint = fields.get("Endpoint") ?? "";
  const endpointHost = endpoint.startsWith("[") ? endpoint.slice(1, endpoint.indexOf("]")) : endpoint.slice(0, endpoint.lastIndexOf(":"));
  if (!endpointHost) throw new Error("The profile needs your VPN provider's Endpoint.");
  const ipv6 = routes.includes("::/0") && addresses.some(address => isIP(address.split("/")[0]!) === 6);
  if (!ipv6 && dns.some(address => isIP(address) === 6)) throw new Error("Use an IPv4 DNS server, or supply an IPv6 Address and ::/0 route.");
  const config = ["[Interface]", `PrivateKey = ${fields.get("PrivateKey")}`, "[Peer]", `PublicKey = ${fields.get("PublicKey")}`,
    ...(fields.has("PresharedKey") ? [`PresharedKey = ${fields.get("PresharedKey")}`] : []),
    `Endpoint = ${endpoint}`, `AllowedIPs = ${routes.join(", ")}`, "PersistentKeepalive = 25", ""].join("\n");
  return { config, addresses, dns, ipv6, endpointHost, mtu: fields.get("MTU") ?? "1420" };
}

/** Host owns namespaces and process launch; the VPN plugin exposes the capability. */
export class DownloadVpn {
  readonly #options: Options;
  readonly #runner: PrivilegedRunner;
  #state: VpnState = { version: 1, bindings: {}, profiles: [] };
  #prepared = new Map<string, string>();
  #preparing = new Map<string, Promise<void>>();
  #queue: Promise<unknown> = Promise.resolve();
  #busy = false;

  constructor(options: Options) { this.#options = options; this.#runner = options.runner ?? new SpawnPrivilegedRunner(); }
  #binding(clientId: string): string | undefined { return Object.hasOwn(this.#state.bindings, clientId) ? this.#state.bindings[clientId] : undefined; }
  namespace(_clientId: string): string { return `ta-${createHash("sha256").update(this.#options.stateDir + "downloads").digest("hex").slice(0,10)}`; }
  async #run(...argv: string[]) { return this.#runner.run({ argv }); }
  async #must(...argv: string[]) {
    const result = await this.#run(...argv);
    if (result.code !== 0) throw new Error(`VPN ${argv[0]} operation failed. Check runtime permissions, installed tools, and the provider profile.`);
    return result.stdout;
  }
  async #privateDirectory(path: string) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("VPN state must use a real directory.");
    await chmod(path, 0o700);
  }
  async #privateFile(path: string, content: string) {
    // Existing generated files are never followed through a symlink.
    const { open, constants } = await import("node:fs/promises");
    const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
    try { await file.chmod(0o600); await file.writeFile(content); } finally { await file.close(); }
  }
  async #persist() { await this.#options.documents.put(VPN_PLUGIN, STATE_KEY, this.#state); }

  async initialize(legacyConfig: Record<string, unknown> = {}) {
    const saved = await this.#options.documents.get(VPN_PLUGIN, STATE_KEY);
    if (saved) {
      const state = saved.doc as VpnState;
      if (!state || state.version !== 1 || !state.bindings || typeof state.bindings !== "object" || !Array.isArray(state.profiles)) throw new Error("VPN state is invalid; restore its configuration backup before starting downloads.");
      for (const [client, profile] of Object.entries(state.bindings)) {
        if (typeof client !== "string" || typeof profile !== "string" || !PROFILE_ID.test(profile)) throw new Error("VPN binding state is invalid; downloads remain stopped.");
      }
      this.#state = { version: 1, bindings: { ...state.bindings }, profiles: state.profiles.map(profile => {
        if (!profile || typeof profile.profileId !== "string" || !PROFILE_ID.test(profile.profileId) || profile.protocol !== "wireguard" || typeof profile.endpointHost !== "string") throw new Error("VPN profile state is invalid; restore its configuration backup.");
        return { profileId: profile.profileId, protocol: "wireguard", endpointHost: profile.endpointHost };
      }) };
      return;
    }
    const previous = (await this.#options.documents.get(VPN_PLUGIN, "vpn-state-v1"))?.doc as { bindings?: Array<{ clientId: string; profileId: string }> } | undefined;
    for (const binding of previous?.bindings ?? (Array.isArray(legacyConfig.bindings) ? legacyConfig.bindings : [])) {
      if (!binding || typeof binding.clientId !== "string" || typeof binding.profileId !== "string" || !PROFILE_ID.test(binding.profileId)) throw new Error("Legacy VPN binding is invalid; downloads remain stopped.");
      this.#state.bindings[binding.clientId] = binding.profileId;
    }
    // Preserve required intent even when an older profile has no recoverable secret.
    for (const raw of Array.isArray(legacyConfig.profiles) ? legacyConfig.profiles : []) {
      if (!raw || typeof raw.profileId !== "string" || !PROFILE_ID.test(raw.profileId) || raw.protocol !== "wireguard" || typeof raw.configText !== "string") continue;
      let profile;
      try { profile = parseDownloadVpnProfile(raw.configText); } catch { continue; }
      await this.#options.secrets.set(VPN_PLUGIN, raw.profileId, raw.configText);
      this.#state.profiles.push({ profileId: raw.profileId, protocol: "wireguard", endpointHost: profile.endpointHost });
    }
    await this.#persist();
  }

  async preflight() {
    const platform = this.#options.platform ?? process.platform;
    const names = ["wg", "ip", "nft", "setpriv"];
    const results = await Promise.all(names.map(name => this.#run(name, name === "ip" ? "-Version" : "--version")));
    const tools = Object.fromEntries(names.map((name, i) => [name, results[i]!.code === 0]));
    const caps = platform === "linux" ? (await this.#run("cat", "/proc/self/status")).stdout.match(/^CapEff:\s*([\da-f]+)$/im)?.[1] : undefined;
    const mask = caps ? BigInt(`0x${caps}`) : 0n;
    const netAdmin = (mask & (1n << 12n)) !== 0n;
    const sysAdmin = (mask & (1n << 21n)) !== 0n;
    const missing = [...(platform === "linux" ? [] : ["linux-host"]), ...names.filter(name => !tools[name]), ...(!netAdmin ? ["CAP_NET_ADMIN"] : []), ...(!sysAdmin ? ["CAP_SYS_ADMIN"] : [])];
    return { platform, tools, tunDevice: false, netAdmin, sysAdmin, supported: missing.length === 0, missing, checkedAt: new Date().toISOString(), lifecycleControlReady: true, enforcementReady: missing.length === 0 };
  }

  async prepareEntry(clientId: string, entry: Entry): Promise<Entry> {
    const profileId = this.#binding(clientId);
    if (!profileId) return entry;
    if (!VPN_CLIENTS.includes(clientId as typeof VPN_CLIENTS[number])) throw new Error("VPN isolation supports the native Torrent and Usenet clients only.");
    if ((this.#options.platform ?? process.platform) !== "linux") throw new Error("VPN-required downloads need a Linux runtime. Direct fallback is disabled.");
    if (new Set(VPN_CLIENTS.map(id => this.#binding(id)).filter(Boolean)).size > 1) throw new Error("Upload one shared WireGuard profile for protected downloads. Multiple legacy profiles remain blocked.");
    if (this.#prepared.get(clientId) !== profileId) {
      if ([...this.#prepared.values()].includes(profileId)) this.#prepared.set(clientId, profileId);
      else {
        const namespace = this.namespace(clientId);
        let pending = this.#preparing.get(namespace);
        if (!pending) {
          pending = this.#prepare(clientId, profileId).finally(() => this.#preparing.delete(namespace));
          this.#preparing.set(namespace, pending);
        }
        await pending;
        if (this.#binding(clientId) !== profileId) throw new Error("VPN configuration changed during startup. Retry the saved connection.");
        this.#prepared.set(clientId, profileId);
      }
    }
    return { command: "ip", args: ["netns", "exec", this.namespace(clientId), "setpriv", "--bounding-set=-all", "--inh-caps=-all", "--ambient-caps=-all", "--no-new-privs", entry.command, ...entry.args], env: entry.env };
  }

  async #prepare(clientId: string, profileId: string) {
    const host = await this.preflight();
    if (!host.supported) throw new Error(`VPN runtime needs: ${host.missing.join(", ")}. Direct fallback is disabled.`);
    const text = await this.#options.secrets.get(VPN_PLUGIN, profileId);
    if (!text) throw new Error("VPN profile credentials are unavailable. Upload the provider profile again; direct fallback is disabled.");
    const profile = parseDownloadVpnProfile(text);
    const namespace = this.namespace(clientId);
    const directory = join(this.#options.stateDir, namespace);
    const dnsDirectory = join(this.#options.netnsConfigDir ?? "/etc/netns", namespace);
    await this.#privateDirectory(directory);
    await this.#privateDirectory(dnsDirectory);
    await this.#privateFile(join(directory, "firewall.nft"), 'flush ruleset\ntable inet tantalar {\n chain output {\n  type filter hook output priority 0; policy drop;\n  oifname "lo" accept\n  oifname "wg0" accept\n }\n}\n');
    const existing = await this.#run("ip", "netns", "exec", namespace, "ip", "link", "show", "lo");
    if (existing.code !== 0) await this.#must("ip", "netns", "add", namespace);
    await this.#must("ip", "netns", "exec", namespace, "nft", "-f", join(directory, "firewall.nft"));
    // Block old tunnel traffic before replacing a namespace from an interrupted run.
    await this.#run("ip", "-n", namespace, "link", "delete", "wg0");
    await this.#run("ip", "link", "delete", namespace);
    await this.#privateFile(join(directory, "wireguard.conf"), profile.config);
    await this.#privateFile(join(dnsDirectory, "resolv.conf"), profile.dns.map(ip => `nameserver ${ip}\n`).join("") + "options timeout:2 attempts:2\n");
    await this.#privateFile(join(dnsDirectory, "nsswitch.conf"), "passwd: files\ngroup: files\nhosts: files dns\nservices: files\nprotocols: files\n");
    try {
      // WireGuard keeps its encrypted UDP socket in its birth namespace.
      await this.#must("ip", "link", "add", namespace, "type", "wireguard");
      await this.#must("wg", "setconf", namespace, join(directory, "wireguard.conf"));
      await this.#must("ip", "link", "set", namespace, "netns", namespace);
      await this.#must("ip", "-n", namespace, "link", "set", namespace, "name", "wg0");
      for (const address of profile.addresses) await this.#must("ip", "-n", namespace, "address", "add", address, "dev", "wg0");
      await this.#must("ip", "-n", namespace, "link", "set", "wg0", "mtu", profile.mtu, "up");
      await this.#must("ip", "-n", namespace, "link", "set", "lo", "up");
      await this.#must("ip", "-n", namespace, "route", "replace", "default", "dev", "wg0");
      if (profile.ipv6) await this.#must("ip", "-n", namespace, "-6", "route", "replace", "default", "dev", "wg0");
      let connected = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        const handshake = await this.#run("ip", "netns", "exec", namespace, "wg", "show", "wg0", "latest-handshakes");
        if (handshake.code === 0 && Number(handshake.stdout.trim().split(/\s+/)[1]) > Date.now() / 1000 - 180) { connected = true; break; }
        await delay(250);
      }
      if (!connected) throw new Error("The VPN peer did not complete a handshake. Check the provider profile and server reachability, then retry.");
      const dnsCheck = await this.#run("ip", "netns", "exec", namespace, process.execPath, "-e", "require('node:dns').resolve4('example.com',(error,addresses)=>process.exit(error||!addresses?.length?1:0))");
      if (dnsCheck.code !== 0) throw new Error("VPN DNS verification failed. Set the provider's reachable DNS IP in the profile, then retry.");
      if (this.#binding(clientId) !== profileId) throw new Error("VPN configuration changed during startup. Retry the saved connection.");
    } catch (error) {
      await this.#run("ip", "-n", namespace, "link", "delete", "wg0");
      await this.#run("ip", "link", "delete", namespace);
      throw error;
    }
  }

  async #check(clientId: string) {
    const profileId = this.#binding(clientId);
    if (!profileId) return { allowDispatch: true, profileId: null, health: null };
    const namespace = this.namespace(clientId);
    if (this.#prepared.get(clientId) !== profileId) return { allowDispatch: false, profileId, health: "down" };
    const [handshakes, routes, firewall] = await Promise.all([
      this.#run("ip", "netns", "exec", namespace, "wg", "show", "wg0", "latest-handshakes"),
      this.#run("ip", "-n", namespace, "route", "show", "default"),
      this.#run("ip", "netns", "exec", namespace, "nft", "list", "chain", "inet", "tantalar", "output"),
    ]);
    const timestamp = Number(handshakes.stdout.trim().split(/\s+/)[1]);
    const healthy = handshakes.code === 0 && timestamp > Date.now() / 1000 - 180 && routes.code === 0 && /default dev wg0\b/.test(routes.stdout) && firewall.code === 0 && /policy drop/.test(firewall.stdout);
    return { allowDispatch: healthy, profileId, health: healthy ? "healthy" : "down" };
  }

  async status() {
    const host = await this.preflight();
    const clients = await Promise.all(VPN_CLIENTS.map(async clientId => ({ clientId, ...await this.#check(clientId) })));
    return { host, lifecycleControlReady: true, enforcementReady: host.supported, openvpnApplySupported: false,
      profiles: this.#state.profiles.map(profile => ({ ...profile, configured: true, applySupported: host.supported })),
      bindings: clients.filter(client => client.profileId).map(client => ({ clientId: client.clientId, profileId: client.profileId, blocked: !client.allowDispatch })),
      clients, busy: this.#busy, checkedAt: host.checkedAt };
  }

  async #configure(payload: Record<string, unknown>) {
    const clients = payload.clientIds;
    if (!Array.isArray(clients) || !clients.length || clients.some(client => !VPN_CLIENTS.includes(client)) || new Set(clients).size !== clients.length) throw new Error("Select native Torrent, native Usenet, or both.");
    const text = payload.configText;
    if (typeof text !== "string") throw new Error("Upload your VPN provider's WireGuard configuration file.");
    const profile = parseDownloadVpnProfile(text);
    const host = await this.preflight();
    if (!host.supported) throw new Error(`Complete runtime setup first: ${host.missing.join(", ")}.`);
    const profileId = `wg-${randomBytes(5).toString("hex")}`;
    await this.#options.secrets.set(VPN_PLUGIN, profileId, text);
    const next = structuredClone(this.#state);
    next.profiles.push({ profileId, protocol: "wireguard", endpointHost: profile.endpointHost });
    const restartClients = [...new Set([...clients, ...VPN_CLIENTS.filter(client => this.#binding(client))])];
    for (const client of restartClients) next.bindings[client] = profileId;
    await this.#options.documents.put(VPN_PLUGIN, STATE_KEY, next);
    this.#state = next; // Required intent survives a failure or restart before any relaunch.
    const failures: string[] = [];
    this.#prepared.clear();
    for (const client of restartClients) {
      try { await this.#options.restartClient(client); } catch { failures.push(client === VPN_CLIENTS[0] ? "Torrent" : "Usenet"); }
    }
    if (failures.length) throw new Error(`${failures.join(" and ")} remain blocked. Enable the selected native modules, check runtime diagnostics, and verify the provider's endpoint and DNS. Use Retry connection to try the saved profile again.`);
    return this.status();
  }

  async #disconnect(payload: Record<string, unknown>) {
    const clientId = String(payload.clientId ?? "");
    if (!VPN_CLIENTS.includes(clientId as typeof VPN_CLIENTS[number]) || payload.confirmDirect !== true) throw new Error("Confirm that this download client may use the direct network.");
    const next = structuredClone(this.#state);
    delete next.bindings[clientId];
    await this.#options.documents.put(VPN_PLUGIN, STATE_KEY, next);
    this.#state = next;
    this.#prepared.delete(clientId);
    await this.#options.restartClient(clientId);
    if (!VPN_CLIENTS.some(client => this.#binding(client))) await this.#run("ip", "-n", this.namespace(clientId), "link", "delete", "wg0");
    return this.status();
  }

  async #reconnect(payload: Record<string, unknown>) {
    const clientId = String(payload.clientId ?? "");
    if (!VPN_CLIENTS.includes(clientId as typeof VPN_CLIENTS[number]) || !this.#binding(clientId)) throw new Error("Select a download client with a saved VPN profile.");
    this.#prepared.clear();
    for (const client of VPN_CLIENTS.filter(id => this.#binding(id))) await this.#options.restartClient(client);
    return this.status();
  }

  async invoke(operation: string, payload: Record<string, unknown>) {
    if (operation === "status") return this.status();
    if (operation === "preflight") return this.preflight();
    if (operation === "pre-dispatch-check") return this.#check(String(payload.clientId ?? ""));
    if (operation === "profiles") return { profiles: this.#state.profiles };
    if (operation === "bindings") return { bindings: Object.entries(this.#state.bindings).map(([clientId, profileId]) => ({ clientId, profileId })) };
    if (operation === "conformance-probe") return { ok: true };
    if (!["configure", "disconnect", "reconnect"].includes(operation)) throw new Error("Use VPN setup to change native download protection.");
    // ponytail: serialize the two native-client mutations; per-client locks only if more engines are added.
    const run = this.#queue.then(async () => { this.#busy = true; try { return operation === "configure" ? await this.#configure(payload) : operation === "disconnect" ? await this.#disconnect(payload) : await this.#reconnect(payload); } finally { this.#busy = false; } });
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async shutdown() {
    await this.#queue;
    this.#prepared.clear();
    for (const clientId of VPN_CLIENTS) {
      if (!this.#binding(clientId)) continue;
      await this.#run("ip", "-n", this.namespace(clientId), "link", "delete", "wg0");
      await this.#run("ip", "netns", "delete", this.namespace(clientId));
    }
  }
}
