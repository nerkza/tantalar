/**
 * Phase 3a indexer-layer tests (stories 1/3/4 plumbing).
 * Covers: provider-neutral query/result schemas, automatic + interactive
 * searches against the fixture indexer plugin (out-of-process), normalized
 * results, rate-limit and retention respect, structured errors, event
 * tracing through the log, and conformance of the fixture plugin.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Kysely } from "kysely";
import { migrate, openDatabase, type Db } from "@tantalar/db";
import {
  EventTypes,
  IndexerError,
  validateIndexerQuery,
  validateIndexedRelease,
  type IndexerSearchResult,
} from "@tantalar/contracts";
import { EventBus } from "../apps/server/src/events.js";
import { ServiceContainer } from "../apps/server/src/container.js";
import { Scheduler } from "../apps/server/src/scheduler.js";
import { Supervisor } from "../apps/server/src/supervisor.js";
import { runConformanceSuite } from "@tantalar/testkit";

const FIXTURE_ENTRY = "node " + resolve("plugins/fixture-indexer/dist/plugin.js");
const INDEXER_CAPABILITY = "dev.tantalar.capability.indexer";

const policy = {
  initialBackoffMs: 100,
  maxBackoffMs: 500,
  backoffMultiplier: 2,
  windowMs: 10_000,
  maxRestartsInWindow: 3,
};

let db: Kysely<Db>;
let bus: EventBus;
let container: ServiceContainer;
let supervisor: Supervisor;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "tantalar-p3a-"));
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
    restartPolicy: policy,
    healthIntervalMs: 500,
    resolveEntry: (m) => {
      const [cmd, ...rest] = m.entry.command.split(" ");
      return { command: cmd ?? "node", args: rest.filter(Boolean), env: {} };
    },
  });
});

afterAll(async () => {
  await supervisor.stopAll();
  await db.destroy();
});

async function mountIndexer(config: Record<string, unknown> = {}) {
  const manifest = {
    id: "dev.tantalar.plugin.fixture-indexer",
    version: "0.1.0",
    protocolVersion: 1,
    provides: [INDEXER_CAPABILITY],
    requires: ["dev.tantalar.capability.event.emit", "dev.tantalar.capability.log"],
    subscriptions: [],
    entry: { command: FIXTURE_ENTRY },
  };
  const rt = await supervisor.mount(manifest, config);
  expect(rt.state).toBe("healthy");
}

function provider() {
  return container.resolve(INDEXER_CAPABILITY);
}

describe("provider-neutral schemas (contracts)", () => {
  it("accepts valid queries in both modes and rejects malformed ones", () => {
    expect(validateIndexerQuery({ mode: "automatic", query: "Fixture Show" }).mode).toBe("automatic");
    expect(validateIndexerQuery({ mode: "interactive", query: "x", limit: 5 }).limit).toBe(5);
    expect(() => validateIndexerQuery({ mode: "sideways", query: "x" })).toThrow(IndexerError);
    expect(() => validateIndexerQuery({ mode: "automatic", query: "" })).toThrow(/non-empty/);
    expect(() => validateIndexerQuery({ mode: "automatic", query: "x", limit: 0 })).toThrow(/positive/);
  });

  it("rejects releases missing required normalized fields", () => {
    expect(validateIndexedRelease({
      guid: "g", title: "t", kind: "nzb", downloadUrl: "https://x", sizeBytes: 1,
      publishedAt: new Date().toISOString(), categories: [], indexerId: "i",
    }).kind).toBe("nzb");
    expect(() =>
      validateIndexedRelease({ guid: "g", title: "", kind: "nzb", downloadUrl: "u", sizeBytes: 1, publishedAt: "now", categories: [], indexerId: "i" }),
    ).toThrow(/title/);
    expect(() =>
      validateIndexedRelease({ guid: "g", title: "t", kind: "usenet", downloadUrl: "u", sizeBytes: 1, publishedAt: "now", categories: [], indexerId: "i" }),
    ).toThrow(/kind/);
  });
});

describe("fixture indexer over the process boundary", () => {
  it("answers an automatic search with normalized results", async () => {
    await mountIndexer();
    const out = (await provider().invoke("search", { mode: "automatic", query: "S01E01" })) as IndexerSearchResult;
    expect(out.releases.length).toBeGreaterThanOrEqual(2);
    for (const r of out.releases) {
      expect(r.indexerId).toBe("dev.tantalar.plugin.fixture-indexer");
      expect(Date.parse(r.publishedAt)).not.toBeNaN();
      expect(["nzb", "torrent"]).toContain(r.kind);
    }
    await supervisor.unmount("dev.tantalar.plugin.fixture-indexer");
  });

  it("supports interactive search including older releases and limit", async () => {
    await mountIndexer({ limits: { retentionDays: 365 } });
    // Automatic mode respects retention; interactive still sees old releases.
    const auto = (await provider().invoke("search", { mode: "automatic", query: "BluRay" })) as IndexerSearchResult;
    expect(auto.releases).toHaveLength(0);
    const inter = (await provider().invoke("search", { mode: "interactive", query: "BluRay" })) as IndexerSearchResult;
    expect(inter.releases).toHaveLength(1);
    expect(inter.releases[0]?.title).toMatch(/2160p BluRay/);
    await supervisor.unmount("dev.tantalar.plugin.fixture-indexer");
  });

  it("respects the configured API rate limit with structured errors", async () => {
    await mountIndexer({ limits: { maxSearchesPerWindow: 2, windowMs: 60_000 } });
    await provider().invoke("search", { mode: "automatic", query: "S01E01" });
    await provider().invoke("search", { mode: "interactive", query: "S01E01" });
    const third = provider().invoke("search", { mode: "automatic", query: "S01E01" });
    // Errors cross the process boundary as messages; assert the structured code text.
    await expect(third).rejects.toThrow(/automatic search limit reached/);
    await supervisor.unmount("dev.tantalar.plugin.fixture-indexer");
  });

  it("reports its limits via the limits operation", async () => {
    await mountIndexer({ limits: { maxSearchesPerWindow: 7, windowMs: 30_000, retentionDays: 14 } });
    const limits = (await provider().invoke("limits", {})) as Record<string, number>;
    expect(limits.maxSearchesPerWindow).toBe(7);
    expect(limits.retentionDays).toBe(14);
    await supervisor.unmount("dev.tantalar.plugin.fixture-indexer");
  });

  it("normalizes a catalog release via parse and errors on unknown ids", async () => {
    await mountIndexer();
    const rel = (await provider().invoke("parse", { guid: "fixture-nzb-0001" })) as Record<string, unknown>;
    expect(rel.kind).toBe("nzb");
    await expect(provider().invoke("parse", { guid: "nope" })).rejects.toThrow(/unknown fixture guid/);
    await expect(provider().invoke("frobnicate", {})).rejects.toThrow(/unknown operation/);
    await supervisor.unmount("dev.tantalar.plugin.fixture-indexer");
  });

  it("traces every search into the immutable event log with correlation", async () => {
    await mountIndexer();
    const corr = "corr-fixture-1";
    await provider().invoke("search", { mode: "automatic", query: "S01E01", correlationId: corr });
    const rows = await bus.read({ correlationId: corr });
    const searched = rows.filter((r) => r.type === EventTypes.IndexerSearched);
    expect(searched).toHaveLength(1);
    expect(searched[0]?.producer).toBe("dev.tantalar.plugin.fixture-indexer");
    expect((searched[0]?.payload as Record<string, unknown>).resultCount).toBeGreaterThan(0);
    await supervisor.unmount("dev.tantalar.plugin.fixture-indexer");
  });

  it("never emits credentials or announce material in event payloads", async () => {
    await mountIndexer();
    const corr = "corr-secret-scan";
    await provider().invoke("search", { mode: "automatic", query: "magnet", correlationId: corr });
    const rows = await bus.read({ correlationId: corr });
    for (const row of rows) {
      // Only the payload is plugin-controlled; scan it for credential material.
      const text = JSON.stringify(row.payload).toLowerCase();
      expect(text).not.toContain("passkey");
      expect(text).not.toContain("secret");
      expect(Object.keys(row.payload as object).every((k) => !/key|token|credential/i.test(k))).toBe(true);
    }
    await supervisor.unmount("dev.tantalar.plugin.fixture-indexer");
  });
});

describe("conformance (phase-2 testkit against the phase-3a fixture)", () => {
  it("passes the published conformance suite out of process", async () => {
    const report = await runConformanceSuite({ packageDir: resolve("plugins/fixture-indexer") });
    expect(report.failed).toBe(0);
    expect(report.passed).toBeGreaterThan(5);
  }, 60_000);
});
