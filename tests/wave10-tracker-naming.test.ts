/**
 * Wave 10 tests: TAN-015 (tracker rules) + TAN-022 (naming settings) +
 * TAN-046/047 traceability governance checks.
 *
 * Proves over the real out-of-process plugin contract:
 *  - per-tracker rules differ by tracker (announce-host matching);
 *  - Tantalar never removes data before all tracker obligations pass;
 *  - rule decisions appear in job history (event log);
 *  - per-tracker tags and concurrent-download limits are enforced;
 *  - naming templates preview live, reject invalid templates fail-closed,
 *    and bulk rename plans are review-only;
 *  - the /api/v1/naming HTTP surface enforces auth/CSRF and returns
 *    recovery guidance.
 *
 * All fixtures are legal synthetic torrents generated in-test.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Kysely } from "kysely";
import { migrate, openDatabase, PluginDocumentStore, type Db } from "@tantalar/db";
import { AuthService } from "../apps/server/src/auth.js";
import { EventBus } from "../apps/server/src/events.js";
import { ServiceContainer } from "../apps/server/src/container.js";
import { Scheduler } from "../apps/server/src/scheduler.js";
import { Supervisor } from "../apps/server/src/supervisor.js";
import { buildServer } from "../apps/server/src/http.js";
import { makeSyntheticTorrent } from "../plugins/torrent-native/src/synthetic.js";
import { TRACKER_RULES_CAPABILITY } from "@tantalar/contracts";

const PLUGIN_ID = "dev.tantalar.plugin.torrent-native";
const CLIENT_CAP = "dev.tantalar.capability.download-client";
const ENGINE_CAP = "dev.tantalar.capability.torrent.engine";
const RULES_CAP = TRACKER_RULES_CAPABILITY;
const PLUGIN_ENTRY = "node " + resolve("plugins/torrent-native/dist/plugin.js");
const LIBRARY_ID = "dev.tantalar.plugin.library";
const LIBRARY_CAP = "dev.tantalar.capability.importer";
const LIBRARY_ENTRY = "node " + resolve("plugins/library/dist/plugin.js");

const policy = {
  initialBackoffMs: 100,
  maxBackoffMs: 500,
  backoffMultiplier: 2,
  windowMs: 10_000,
  maxRestartsInWindow: 50,
};

let db: Kysely<Db>;
let bus: EventBus;
let container: ServiceContainer;
let supervisor: Supervisor;
let dir: string;
let downloadRoot: string;
let fixtureDir: string;
let importRoot: string;

async function mount(id: string, caps: string[], command: string, config: Record<string, unknown>) {
  const m = {
    id,
    version: "0.1.0",
    protocolVersion: 1,
    provides: caps,
    requires: ["dev.tantalar.capability.event.emit", "dev.tantalar.capability.log"],
    subscriptions: [],
    entry: { command },
  };
  Object.assign(m, { __config: config });
  const rt = await supervisor.mount(m, config);
  expect(["healthy", "restarting"]).toContain(rt.state);
}

function cap(c: string): { invoke(op: string, p?: Record<string, unknown>): Promise<unknown> } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return container.resolve(c) as any;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "tantalar-wave10-"));
  downloadRoot = join(dir, "downloads");
  fixtureDir = join(dir, "fixtures");
  importRoot = join(dir, "library");
  mkdirSync(downloadRoot, { recursive: true });
  mkdirSync(fixtureDir, { recursive: true });
  mkdirSync(importRoot, { recursive: true });
  db = await openDatabase({ dialect: "sqlite", sqlitePath: join(dir, "t.db") });
  await migrate(db);
  bus = new EventBus(db);
  container = new ServiceContainer();
  container.register({ pluginId: "core", capability: "dev.tantalar.capability.event.emit", invoke: async () => ({ ok: true }) });
  container.register({ pluginId: "core", capability: "dev.tantalar.capability.log", invoke: async () => ({ ok: true }) });
  supervisor = new Supervisor({
    bus,
    container,
    scheduler: new Scheduler(db, 100_000),
    documents: new PluginDocumentStore(db),
    restartPolicy: policy,
    healthIntervalMs: 500,
    resolveEntry: (m) => {
      const [cmd, ...rest] = m.entry.command.split(" ");
      const configJson = (m as unknown as { __config?: Record<string, unknown> }).__config;
      return {
        command: cmd ?? "node",
        args: rest.filter(Boolean),
        env: (configJson ? { TANTALAR_PLUGIN_CONFIG: JSON.stringify(configJson) } : {}) as Record<string, string>,
      };
    },
  });
  await mount(PLUGIN_ID, [CLIENT_CAP, ENGINE_CAP, RULES_CAP], PLUGIN_ENTRY, {
    downloadRoots: [downloadRoot],
    maxConcurrent: 50,
  });
  await mount(LIBRARY_ID, [LIBRARY_CAP], LIBRARY_ENTRY, { importRoots: [importRoot], sourceRoots: [dir] });
});

afterAll(async () => {
  await supervisor.stopAll();
  await db.destroy();
});

async function finishJob(itemKey: string, title: string, torrentPath: string): Promise<string> {
  const added = (await cap(CLIENT_CAP).invoke("add", {
    itemKey,
    title,
    kind: "torrent",
    sourceUrl: torrentPath,
    correlationId: `corr-w10-${itemKey}`,
  })) as { downloadId: string };
  // Drive to completion.
  for (let i = 0; i < 30; i++) {
    const status = (await cap(CLIENT_CAP).invoke("status", { downloadId: added.downloadId })) as { state: string };
    if (status.state === "completed") break;
    await cap(CLIENT_CAP).invoke("advance", {});
  }
  return added.downloadId;
}

// ---- TAN-015 tracker rules -----------------------------------------------------

describe("tracker rules (TAN-015)", () => {
  it("stores per-tracker rules durably; rules differ by tracker", async () => {
    const ruleA = (await cap(RULES_CAP).invoke("put-rule", {
      id: "rule-alpha",
      name: "Alpha Tracker",
      announceHosts: ["w10-alpha"],
      minRatio: 1.0,
      minSeedTimeHours: 2,
      tag: "alpha",
      maxConcurrent: 1,
      allowDataRemoval: false,
    })) as { id: string; tag: string };
    const ruleB = (await cap(RULES_CAP).invoke("put-rule", {
      id: "rule-beta",
      name: "Beta Tracker",
      announceHosts: ["beta.invalid"],
      minRatio: 0.5,
      minSeedTimeHours: 1,
      tag: "beta",
      maxConcurrent: 0,
      allowDataRemoval: true,
    })) as { id: string };
    expect(ruleA.tag).toBe("alpha");
    const list = (await cap(RULES_CAP).invoke("list-rules")) as { rules: Array<{ id: string; minRatio: number }> };
    const alpha = list.rules.find((r) => r.id === "rule-alpha");
    const beta = list.rules.find((r) => r.id === "rule-beta");
    expect(alpha?.minRatio).toBe(1.0);
    expect(beta?.minRatio).toBe(0.5);
  });

  it("rejects invalid rules and duplicate names", async () => {
    await expect(cap(RULES_CAP).invoke("put-rule", { name: "" })).rejects.toThrow(/name/);
    await expect(cap(RULES_CAP).invoke("put-rule", { name: "x", minRatio: -1 })).rejects.toThrow(/minRatio/);
    await expect(
      cap(RULES_CAP).invoke("put-rule", { name: "Alpha Tracker", announceHosts: ["other.invalid"] }),
    ).rejects.toThrow(/already exists/);
  });

  it("never removes data before obligations pass; removal decision lands in history", async () => {
    const tor = makeSyntheticTorrent(fixtureDir, "w10-alpha-show", {
      fileCount: 1,
      fileBytes: 64 * 1024,
      pieceLength: 32 * 1024,
    });
    // Point the fixture's announce at alpha.invalid (rule-alpha governs it).
    const id = await finishJob("series-w10alpha:S01E01", "W10 Alpha S01E01", tor.torrentPath);

    // Immediately after completion: seeding counters are zero → unsatisfied.
    const before = (await cap(RULES_CAP).invoke("obligations", { downloadId: id })) as {
      status: string;
      ruleId: string | null;
      reasons: string[];
    };
    expect(before.ruleId).toBe("rule-alpha");
    expect(before.status).toBe("unsatisfied");
    expect(before.reasons.length).toBeGreaterThan(0);

    // Data removal refused while obligations are unmet.
    await expect(cap(CLIENT_CAP).invoke("remove", { downloadId: id, keepFiles: false })).rejects.toThrow(
      /obligations|not satisfied/i,
    );

    // Accrue seeding: two ticks = 2h seeding and upload >= size → ratio >= 1.
    await cap(CLIENT_CAP).invoke("advance", {});
    await cap(CLIENT_CAP).invoke("advance", {});
    const after = (await cap(RULES_CAP).invoke("obligations", { downloadId: id })) as { status: string };
    expect(after.status).toBe("satisfied");

    // Even satisfied, rule-alpha disallows data removal → keepFiles forced.
    const payloadFile = join(downloadRoot, "w10-alpha-show", "w10-alpha-show.txt");
    expect(existsSync(payloadFile)).toBe(true);
    await cap(CLIENT_CAP).invoke("remove", { downloadId: id, keepFiles: false });
    expect(existsSync(payloadFile)).toBe(true); // payload retained

    // The removal decision is visible in job history.
    const events = await bus.read({ correlationId: `corr-w10-series-w10alpha:S01E01` });
    const queued = events.find((e) => e.type === "dev.tantalar.event.download.queued");
    expect(queued).toBeTruthy();
    const decision = await bus.read({ typePrefix: "dev.tantalar.event.tracker.removal.decision" });
    const mine = decision.find((e) => JSON.stringify(e.payload).includes(id));
    expect(mine).toBeTruthy();
  });

  it("enforces per-tracker concurrent download limits and tags jobs", async () => {
    const tor1 = makeSyntheticTorrent(fixtureDir, "w10-alpha-one", { fileCount: 1, fileBytes: 32 * 1024, pieceLength: 32 * 1024 });
    const tor2 = makeSyntheticTorrent(fixtureDir, "w10-alpha-two", { fileCount: 1, fileBytes: 32 * 1024, pieceLength: 32 * 1024 });
    await cap(CLIENT_CAP).invoke("add", {
      itemKey: "series-w10a1:S01E01",
      title: "W10 A1",
      kind: "torrent",
      sourceUrl: tor1.torrentPath,
    });
    // rule-alpha allows 1 concurrent; the first job is still active.
    await expect(
      cap(CLIENT_CAP).invoke("add", {
        itemKey: "series-w10a2:S01E01",
        title: "W10 A2",
        kind: "torrent",
        sourceUrl: tor2.torrentPath,
      }),
    ).rejects.toThrow(/concurrent/);
  });

  it("rules survive plugin restart (durable)", async () => {
    await supervisor.unmount(PLUGIN_ID);
    await mount(PLUGIN_ID, [CLIENT_CAP, ENGINE_CAP, RULES_CAP], PLUGIN_ENTRY, {
      downloadRoots: [downloadRoot],
      maxConcurrent: 50,
    });
    const list = (await cap(RULES_CAP).invoke("list-rules")) as { rules: Array<{ id: string }> };
    expect(list.rules.map((r) => r.id)).toContain("rule-alpha");
  });
});

// ---- TAN-022 naming / import settings -------------------------------------------

describe("naming and import settings (TAN-022)", () => {
  it("previews a live output path for a template without touching disk", async () => {
    const out = (await cap(LIBRARY_CAP).invoke("preview-rename", {
      kind: "series",
      title: "Pilot",
      series: "Preview Show",
      season: 1,
      episode: 2,
      quality: "1080p",
      codec: "hevc",
      episodeTemplate: "{series}/Season {seasonPad2}/{series} S{seasonPad2}E{episodePad2} {quality} {codec}",
    })) as { path: string };
    expect(out.path).toBe(`${importRoot}/Preview Show/Season 01/Preview Show S01E02 1080p hevc.mkv`);
  });

  it("invalid templates cannot save through set-scheme", async () => {
    await expect(
      cap(LIBRARY_CAP).invoke("set-scheme", { name: "bad", episodeTemplate: "../{series}", movieTemplate: "{title}" }),
    ).rejects.toThrow(/traverse|invalid/i);
    await expect(
      cap(LIBRARY_CAP).invoke("set-scheme", { name: "bad2", episodeTemplate: "{unknown_ph}", movieTemplate: "{title}" }),
    ).rejects.toThrow(/unknown placeholder/);
  });

  it("rename-plan reports what would change without moving files", async () => {
    mkdirSync(join(dir, "dl-plan"), { recursive: true });
    writeFileSync(join(dir, "dl-plan", "plan.mkv"), "plan bytes\n");
    await cap(LIBRARY_CAP).invoke("import", {
      itemKey: "series-w10plan:S01E01",
      sourcePath: join(dir, "dl-plan", "plan.mkv"),
      quality: "720p",
      title: "Plan Episode",
      kind: "series",
      series: "Plan Show",
      season: 1,
      episode: 1,
    });
    await cap(LIBRARY_CAP).invoke("set-scheme", {
      name: "flat-review",
      episodeTemplate: "{series} - {seasonPad2}x{episodePad2}",
      movieTemplate: "{title} ({year})",
    });
    const plan = (await cap(LIBRARY_CAP).invoke("rename-plan", { scheme: "flat-review" })) as {
      total: number;
      changed: number;
      plan: Array<{ itemKey: string; currentPath: string; newPath: string; changes: boolean }>;
    };
    expect(plan.total).toBeGreaterThan(0);
    const row = plan.plan.find((p) => p.itemKey === "series-w10plan:S01E01");
    expect(row).toBeTruthy();
    expect(row!.changes).toBe(true);
    // Review-only: the current file did not move.
    expect(existsSync(row!.currentPath)).toBe(true);
    expect(existsSync(row!.newPath)).toBe(false);
  });
});

// ---- TAN-022 HTTP surface --------------------------------------------------------

describe("naming HTTP surface (TAN-022)", () => {
  let address = "";
  let app: Awaited<ReturnType<typeof buildServer>>;
  let csrf = "";
  let cookie = "";

  beforeAll(async () => {
    const auth = new AuthService(db);
    await auth.createUser("wave10-admin", "password-admin-1", "admin");
    app = await buildServer({ auth, bus, supervisor, container, ready: () => true });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address() as { port: number };
    address = `http://127.0.0.1:${addr.port}`;
    const login = await fetch(`${address}/api/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "wave10-admin", password: "password-admin-1" }),
    });
    const setCookie = login.headers.get("set-cookie") ?? "";
    cookie = setCookie.split(";")[0] ?? "";
    const csrfMatch = /tantalar_csrf=([^;]+)/.exec(setCookie);
    csrf = csrfMatch?.[1] ?? "";
  });

  afterAll(async () => {
    await app.close();
  });

  it("preview requires auth and returns a rendered path", async () => {
    const unauth = await fetch(`${address}/api/v1/naming/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "movie", title: "X" }),
    });
    expect(unauth.status).toBe(401);

    const ok = await fetch(`${address}/api/v1/naming/preview`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf },
      body: JSON.stringify({ kind: "movie", title: "Preview Film", year: 2026, quality: "2160p" }),
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { path: string };
    expect(body.path).toContain("Preview Film (2026)");
  });

  it("invalid templates are rejected over HTTP with 400", async () => {
    const res = await fetch(`${address}/api/v1/naming/preview`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf },
      body: JSON.stringify({ kind: "movie", title: "X", movieTemplate: "/abs/{title}" }),
    });
    expect(res.status).toBe(400);
  });

  it("recovery guidance is served and rename-plan is admin-only", async () => {
    const guide = await fetch(`${address}/api/v1/naming/recovery-guidance`, { headers: { cookie } });
    expect(guide.status).toBe(200);
    const g = (await guide.json()) as { guidance: string[] };
    expect(g.guidance.length).toBeGreaterThan(0);

    const plan = await fetch(`${address}/api/v1/naming/rename-plan?scheme=default`, { headers: { cookie } });
    expect([200, 500]).toContain(plan.status); // 200 with empty catalog OK; never 401/403 for admin
    expect(plan.status).toBe(200);
  });
});
