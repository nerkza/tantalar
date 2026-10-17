import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginDocumentStore } from "@tantalar/db";
import { boot, type Kernel } from "../apps/server/src/kernel.js";
import { Backups } from "../apps/server/src/backups.js";
import { SecretStore } from "../apps/server/src/secret-store.js";

const kernels: Kernel[] = [], dirs: string[] = [];
afterEach(async () => { for (const kernel of kernels.splice(0)) await kernel.shutdown(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "tantalar-config-test-")); dirs.push(dir);
  const options = { skipConfigPlugins: true, env: {}, cliOverrides: { server: { port: 0 }, database: { sqlite: { path: join(dir, "test.db") } }, plugins: { requiredCapabilities: [] } } };
  const kernel = await boot(options); kernels.push(kernel);
  await kernel.auth.createInitialAdmin("saved-admin", "saved-password-1");
  const backups = new Backups(kernel.db, dir, join(dir, "test.db"), kernel.config.config, kernel.scheduler);
  const secrets = new SecretStore(join(dir, ".secrets.json"));
  return { dir, options, kernel, backups, secrets };
}

describe("complete configuration files", () => {
  it("restores database, settings and credentials before boot, preserving the host database location", async () => {
    const f = await fixture();
    const store = new PluginDocumentStore(f.kernel.db);
    await store.put("test-plugin", "settings", { library: "/media", enabled: true });
    await f.secrets.set("test-plugin", "api-key", "saved-secret");
    const vpnOwner = "dev.tantalar.plugin.vpn-manager";
    const vpnState = { version: 1, bindings: { "dev.tantalar.plugin.torrent-native": "saved-vpn" }, profiles: [] };
    await store.put(vpnOwner, "download-vpn-v1", vpnState);
    await f.secrets.set(vpnOwner, "saved-vpn", "[Interface]\nPrivateKey = saved-provider-key\n");
    const file = await f.backups.snapshot();
    file.config.logging = { level: "debug" };
    file.config.database = { dialect: "sqlite", sqlite: { path: "/must-not-be-used.db" } };
    await store.put("test-plugin", "settings", { enabled: false });
    await f.secrets.set("test-plugin", "api-key", "changed-secret");
    await f.backups.stage(file);
    expect((await store.get("test-plugin", "settings"))?.doc).toEqual({ enabled: false });
    expect((await f.backups.settings()).pendingImport).toBe(true);
    await f.kernel.shutdown(); kernels.splice(kernels.indexOf(f.kernel), 1);
    const restored = await boot(f.options); kernels.push(restored);
    expect((await new PluginDocumentStore(restored.db).get("test-plugin", "settings"))?.doc).toEqual({ library: "/media", enabled: true });
    expect(await f.secrets.get("test-plugin", "api-key")).toBe("saved-secret");
    expect(await f.secrets.get(vpnOwner, "saved-vpn")).toBe("[Interface]\nPrivateKey = saved-provider-key\n");
    expect((await new PluginDocumentStore(restored.db).get(vpnOwner, "download-vpn-v1"))?.doc).toEqual(vpnState);
    expect(restored.config.config.logging).toEqual({ level: "debug" });
    expect(restored.config.config.database).toMatchObject({ sqlite: { path: join(f.dir, "test.db") } });
    expect((await stat(join(f.dir, "configuration.pre-restore.db"))).size).toBeGreaterThan(0);
    expect((await stat(join(f.dir, "configuration.runtime.json"))).mode & 0o777).toBe(0o600);
    expect(await restored.db.selectFrom("sessions").selectAll().execute()).toEqual([]);
    expect((await new Backups(restored.db, f.dir, join(f.dir, "test.db"), restored.config.config, restored.scheduler).settings()).pendingImport).toBe(false);
  });

  it("runs the daily job, preserves overrides and prunes only completed automatic backups", async () => {
    const { kernel, backups, dir } = await fixture();
    expect(await backups.settings()).toMatchObject({ enabled: true, schedule: "daily 02:00", retention: 7 });
    await backups.update({ directory: join(dir, "custom"), retention: 1, enabled: true, schedule: "daily 05:45" });
    await backups.register();
    expect(await backups.settings()).toMatchObject({ schedule: "daily 05:45" });
    const manual = await backups.save();
    await writeFile(join(dir, "custom", "unrelated.json"), "keep");
    await kernel.scheduler.runNow("core::backup");
    await kernel.scheduler.runNow("core::backup");
    const files = await readdir(join(dir, "custom"));
    expect(files.filter(name => name.startsWith("tantalar-auto-"))).toHaveLength(1);
    expect(files).toContain("unrelated.json");
    expect((await stat(manual.path)).mode & 0o777).toBe(0o600);
    expect((await backups.settings()).latestRun?.state).toBe("succeeded");
    await backups.update({ directory: join(dir, "custom"), retention: 0, enabled: false, schedule: "every 48h" });
    await backups.register();
    expect(await backups.settings()).toMatchObject({ enabled: false, nextRunAt: null, retention: 0 });
    await expect(backups.update({ directory: dir, retention: -1, enabled: true, schedule: "invalid" })).rejects.toThrow("Invalid backup settings");
  });

  it("rejects malformed, corrupt and unsafe files, and allows cancelling a staged import", async () => {
    const { backups, dir } = await fixture();
    const file = await backups.snapshot();
    await expect(backups.stage({})).rejects.toThrow("Invalid configuration");
    await expect(backups.stage({ ...file, version: 2 })).rejects.toThrow("Unsupported");
    await expect(backups.stage({ ...file, database: { ...file.database, sha256: "wrong" } })).rejects.toThrow("checksum");
    await expect(backups.stage(JSON.parse(JSON.stringify(file).replace('"config":{', '"config":{"__proto__":{},')))).rejects.toThrow("Unsafe");
    const saved = await backups.save();
    const outside = join(dir, "outside.json");
    await writeFile(outside, await readFile(saved.path));
    await symlink(outside, join(dir, "backups", "escape.json"));
    await expect(backups.stagePath(join(dir, "backups", "escape.json"))).rejects.toThrow("inside the managed");
    await backups.stage(file);
    await expect(backups.stage(file)).rejects.toThrow("already pending");
    await backups.cancel();
    expect((await backups.settings()).pendingImport).toBe(false);
  });

  it("captures custom named credential references without copying unrelated environment values", async () => {
    const { backups, kernel } = await fixture();
    process.env["CUSTOM_NNTP_PASSWORD"] = "test-provider-password";
    try {
      await new PluginDocumentStore(kernel.db).put("test-plugin", "settings", { passwordEnv: "CUSTOM_NNTP_PASSWORD" });
      const file = await backups.snapshot();
      const alias = Object.keys(file.environment).find(key => key.startsWith("TANTALAR_SECRET_IMPORTED_"));
      expect(alias).toBeTruthy();
      expect(file.environment[alias!]).toBe("test-provider-password");
      expect(file.environment["CUSTOM_NNTP_PASSWORD"]).toBeUndefined();
      expect(file.environment["PATH"]).toBeUndefined();
      await backups.stage(file);
    } finally { delete process.env["CUSTOM_NNTP_PASSWORD"]; }
  });

  it("requires an administrator and CSRF for import, and prevents cached credential exports", async () => {
    const { kernel, backups } = await fixture();
    const address = await kernel.listen("127.0.0.1", 0);
    expect((await fetch(`${address}/api/v1/system/configuration`)).status).toBe(401);
    const login = await fetch(`${address}/api/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "saved-admin", password: "saved-password-1" }) });
    expect(login.status).toBe(200);
    const cookie = login.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    const { csrfToken } = await login.json() as { csrfToken: string };
    const exported = await fetch(`${address}/api/v1/system/configuration`, { headers: { cookie } });
    expect(exported.headers.get("cache-control")).toBe("no-store");
    const file = await exported.json();
    const input = { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(file) };
    expect((await fetch(`${address}/api/v1/system/configuration/import`, input)).status).toBe(403);
    const result = await fetch(`${address}/api/v1/system/configuration/import`, { ...input, headers: { ...input.headers, "x-csrf-token": csrfToken } });
    expect(result.status).toBe(200);
    expect((await backups.settings()).pendingImport).toBe(true);
  });
});
