// Linux root-only integration check. Runs against a local WireGuard peer; no VPN subscription or internet download.
// Build first, then run in a disposable Linux environment with ip, wg, nft, setpriv, dnsmasq and curl.
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { DownloadVpn, VPN_CLIENTS, VPN_PLUGIN, VPN_CONTROL } from "../apps/server/dist/download-vpn.js";
import { Supervisor } from "../apps/server/dist/supervisor.js";
import { ServiceContainer } from "../apps/server/dist/container.js";
import { SecretStore } from "../apps/server/dist/secret-store.js";

assert.equal(process.platform, "linux", "Run this check in the disposable Linux VPN test environment.");
const dir = await mkdtemp(join(tmpdir(), "tantalar-vpn-proof-"));
const run = (command, args, input) => execFileSync(command, args, { encoding: "utf8", input, timeout: 15_000, stdio: ["pipe", "pipe", "pipe"] }).trim();
const clientKey = run("wg", ["genkey"]);
const clientPublic = run("wg", ["pubkey"], clientKey);
const serverKey = run("wg", ["genkey"]);
const serverPublic = run("wg", ["pubkey"], serverKey);
const hostInterface = `tp${process.pid}`.slice(0, 15);
let dns;
let dnsLog = "";
let observedSource;
let supervisor;
let stream;
const server = createServer((request, response) => {
  observedSource = request.socket.remoteAddress;
  if (request.url === "/stream") {
    const timer = setInterval(() => response.write(Buffer.alloc(1024)), 100);
    response.on("close", () => clearInterval(timer));
  } else response.end("vpn-proof");
});
const docs = new Map();
const options = {
  stateDir: dir,
  documents: { get: async (_owner, key) => docs.has(key) ? { doc: structuredClone(docs.get(key)) } : null,
    put: async (_owner, key, doc) => { docs.set(key, structuredClone(doc)); } },
  secrets: new SecretStore(join(dir, ".secrets.json")),
  restartClient: async clientId => { if (supervisor?.get(clientId)) await supervisor.restart(clientId); else await controller.prepareEntry(clientId, { command: "node", args: [], env: {} }); },
};
let controller = new DownloadVpn(options);
const namespace = controller.namespace(VPN_CLIENTS[0]);
const namespace2 = controller.namespace(VPN_CLIENTS[1]);
async function until(check) {
  for (let i = 0; i < 50; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.fail("Timed out waiting for the local WireGuard handshake.");
}
function fails(command, args) { try { run(command, args); return false; } catch { return true; } }
try {
  await writeFile(join(dir, "server.key"), serverKey, { mode: 0o600 });
  run("ip", ["link", "add", hostInterface, "type", "wireguard"]);
  run("ip", ["address", "add", "10.72.0.1/24", "dev", hostInterface]);
  run("wg", ["set", hostInterface, "private-key", join(dir, "server.key"), "listen-port", "51820", "peer", clientPublic, "allowed-ips", "10.72.0.2/32"]);
  run("ip", ["link", "set", hostInterface, "up"]);
  await new Promise(resolve => server.listen(18080, "0.0.0.0", resolve));
  dns = spawn("dnsmasq", ["--no-daemon", "--no-resolv", "--no-hosts", "--listen-address=10.72.0.1", "--bind-interfaces", "--address=/vpn-proof.test/10.72.0.1", "--address=/example.com/10.72.0.1", "--log-queries=extra", "--log-facility=-"], { stdio: ["ignore", "ignore", "pipe"] });
  dns.stderr.on("data", data => { dnsLog += String(data); });
  await controller.initialize();
  const profile = `[Interface]\nPrivateKey = ${clientKey}\nAddress = 10.72.0.2/32\nDNS = 10.72.0.1\n[Peer]\nPublicKey = ${serverPublic}\nEndpoint = 127.0.0.1:51820\nAllowedIPs = 0.0.0.0/0\n`;
  await controller.invoke("configure", { configText: profile, clientIds: [VPN_CLIENTS[0]] });
  await until(async () => (await controller.invoke("pre-dispatch-check", { clientId: VPN_CLIENTS[0] })).allowDispatch);
  const entry = await controller.prepareEntry(VPN_CLIENTS[0], { command: "node", args: ["-e", "fetch('http://vpn-proof.test:18080').then(r=>r.text()).then(console.log)"], env: {} });
  assert.equal((await promisify(execFile)(entry.command, entry.args, { timeout: 10_000 })).stdout.trim(), "vpn-proof");
  assert.equal(observedSource, "10.72.0.2", "The download must reach the peer through WireGuard.");
  assert.match(dnsLog, /10\.72\.0\.2/, "DNS queries must originate inside the WireGuard tunnel.");
  const caps = run("ip", ["netns", "exec", namespace, "setpriv", "--bounding-set=-all", "--inh-caps=-all", "--ambient-caps=-all", "--no-new-privs", "cat", "/proc/self/status"]);
  assert.match(caps, /CapEff:\s*0+\n/);
  assert.match(caps, /CapBnd:\s*0+\n/);
  assert.match(caps, /NoNewPrivs:\s*1\n/);
  const direct = await controller.prepareEntry("dev.tantalar.plugin.serving", { command: "node", args: [], env: {} });
  assert.equal(direct.command, "node", "Playback must retain its normal network.");
  assert.equal(await (await fetch("http://127.0.0.1:18080")).text(), "vpn-proof");
  let chunks = 0;
  stream = spawn("ip", ["netns", "exec", namespace, "node", "-e", "require('http').get('http://10.72.0.1:18080/stream',r=>r.on('data',()=>console.log('chunk'))).on('error',()=>{})"], { stdio: ["ignore", "pipe", "ignore"] });
  stream.stdout.on("data", () => chunks++);
  await until(() => chunks >= 3);
  run("ip", ["-n", namespace, "link", "delete", "wg0"]);
  await new Promise(resolve => setTimeout(resolve, 300));
  const afterLoss = chunks;
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(chunks, afterLoss, "An established transfer must stop when its tunnel disappears.");
  stream.kill("SIGKILL");
  assert.equal((await controller.invoke("pre-dispatch-check", { clientId: VPN_CLIENTS[0] })).allowDispatch, false);
  assert.equal(fails("ip", ["netns", "exec", namespace, "curl", "--max-time", "2", "http://vpn-proof.test:18080"]), true);
  assert.equal(await (await fetch("http://127.0.0.1:18080")).text(), "vpn-proof", "Tunnel loss must not stop the control server.");
  // Even an accidentally added direct route must not defeat the output firewall (IPv4 or IPv6).
  run("ip", ["link", "add", "proof-host", "type", "veth", "peer", "name", "proof-direct"]);
  run("ip", ["link", "set", "proof-direct", "netns", namespace]);
  run("ip", ["address", "add", "192.0.2.1/24", "dev", "proof-host"]);
  run("ip", ["-6", "address", "add", "fd72::1/64", "dev", "proof-host", "nodad"]);
  run("ip", ["link", "set", "proof-host", "up"]);
  run("ip", ["-n", namespace, "address", "add", "192.0.2.2/24", "dev", "proof-direct"]);
  run("ip", ["-n", namespace, "-6", "address", "add", "fd72::2/64", "dev", "proof-direct", "nodad"]);
  run("ip", ["-n", namespace, "link", "set", "proof-direct", "up"]);
  assert.equal(fails("ip", ["netns", "exec", namespace, "curl", "--max-time", "2", "http://192.0.2.1:18080"]), true);
  assert.equal(fails("ip", ["netns", "exec", namespace, "curl", "-g", "--max-time", "2", "http://[fd72::1]:18080"]), true);
  run("ip", ["link", "delete", "proof-host"]);
  // A fresh controller must recover required intent and never return a direct entry.
  controller = new DownloadVpn(options);
  await controller.initialize();
  assert.equal((await controller.invoke("pre-dispatch-check", { clientId: VPN_CLIENTS[0] })).allowDispatch, false);
  const recovered = await controller.prepareEntry(VPN_CLIENTS[0], { command: "node", args: [], env: {} });
  assert.equal(recovered.command, "ip");
  await until(async () => (await controller.invoke("pre-dispatch-check", { clientId: VPN_CLIENTS[0] })).allowDispatch);
  const independent = await controller.prepareEntry(VPN_CLIENTS[1], { command: "node", args: [], env: {} });
  assert.equal(independent.command, "node", "Unselected download clients remain direct.");
  assert.equal(namespace, namespace2, "Clients using one provider profile must share its tunnel.");
  assert(!JSON.stringify(await controller.status()).includes(clientKey), "Status must not expose profile secrets.");
  const container = new ServiceContainer();
  for (const capability of ["dev.tantalar.capability.event.emit", "dev.tantalar.capability.log"]) container.register({ pluginId: "core", capability, invoke: async () => ({ ok: true }) });
  container.register({ pluginId: "core", capability: VPN_CONTROL, invoke: (operation, payload) => {
    assert.equal(payload.requesterPluginId, VPN_PLUGIN);
    return controller.invoke(operation, payload);
  } });
  supervisor = new Supervisor({
    bus: { publish: async () => ({}) }, container, scheduler: { removeJobsFor: async () => {} }, documents: options.documents,
    restartPolicy: { initialBackoffMs: 50, maxBackoffMs: 200, backoffMultiplier: 2, windowMs: 60_000, maxRestartsInWindow: 3 },
    prepareEntry: (manifest, entry) => controller.prepareEntry(manifest.id, entry),
    resolveEntry: manifest => ({ command: "node", args: [`/work/plugins/${manifest.id.split(".").pop()}/dist/plugin.js`], env: manifest.id === VPN_PLUGIN ? { TANTALAR_MANAGED_VPN: "1" } : {} }),
  });
  await supervisor.mount(JSON.parse(await readFile("plugins/vpn-manager/manifest.json", "utf8")));
  await supervisor.mount(JSON.parse(await readFile("plugins/torrent-native/manifest.json", "utf8")), { downloadRoots: [dir], minFreeBytes: 0 });
  const proc = supervisor.testGetProc(VPN_CLIENTS[0]);
  assert.equal((await stat(`/proc/${proc.pid}/ns/net`)).ino, (await stat(`/run/netns/${namespace}`)).ino, "The real native downloader process must enter the protected namespace.");
  observedSource = undefined;
  // Deliberately invalid metainfo reaches the real source-fetch path, then fails parsing.
  await assert.rejects(container.resolve("dev.tantalar.capability.download-client").invoke("add", { itemKey: "vpn-real-source-proof", title: "VPN source proof", kind: "torrent", sourceUrl: "http://vpn-proof.test:18080/proof.torrent" }));
  assert.equal(observedSource, "10.72.0.2", "The real downloader's HTTP source fetch must use WireGuard.");
  proc.stdin.end();
  await until(() => supervisor.testGetProc(VPN_CLIENTS[0])?.pid !== proc.pid && supervisor.get(VPN_CLIENTS[0])?.state === "healthy");
  const restarted = supervisor.testGetProc(VPN_CLIENTS[0]);
  assert.equal((await stat(`/proc/${restarted.pid}/ns/net`)).ino, (await stat(`/run/netns/${namespace}`)).ino, "Control-pipe loss must stop the old process and recover inside VPN isolation.");
  container.register({ pluginId: "core", capability: "dev.tantalar.capability.secret.resolve", invoke: async () => ({ value: "" }) });
  await supervisor.mount(JSON.parse(await readFile("plugins/usenet-native/manifest.json", "utf8")), { downloadRoots: [dir], servers: [] });
  await container.resolve("dev.tantalar.capability.vpn-binding").invoke("configure", { configText: profile, clientIds: [VPN_CLIENTS[1]] });
  const torrentProcess = supervisor.testGetProc(VPN_CLIENTS[0]);
  const usenetProcess = supervisor.testGetProc(VPN_CLIENTS[1]);
  assert.equal((await stat(`/proc/${torrentProcess.pid}/ns/net`)).ino, (await stat(`/proc/${usenetProcess.pid}/ns/net`)).ino, "Both native download processes must share one provider tunnel.");
  assert.equal((await controller.invoke("pre-dispatch-check", { clientId: VPN_CLIENTS[1] })).allowDispatch, true);
  await controller.invoke("disconnect", { clientId: VPN_CLIENTS[0], confirmDirect: true });
  assert.equal((await stat(`/proc/${supervisor.testGetProc(VPN_CLIENTS[0]).pid}/ns/net`)).ino, (await stat("/proc/self/ns/net")).ino, "Explicit direct selection changes only that client.");
  assert.equal((await controller.invoke("pre-dispatch-check", { clientId: VPN_CLIENTS[1] })).allowDispatch, true, "Disconnecting Torrent must not remove Usenet's tunnel.");
  console.log("PASS: real native download source fetch, WireGuard transfer, tunneled DNS, dropped privileges, active-socket loss, IPv4/IPv6 kill switch, controller/process restart recovery, unchanged control/playback network.");
} finally {
  await supervisor?.stopAll();
  stream?.kill("SIGKILL");
  dns?.kill("SIGKILL");
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  for (const args of [["link", "delete", "proof-host"], ["link", "delete", hostInterface], ["netns", "delete", namespace], ["netns", "delete", namespace2]]) { try { run("ip", args); } catch {} }
  await rm(dir, { recursive: true, force: true });
  await rm(join("/etc/netns", namespace), { recursive: true, force: true });
}
