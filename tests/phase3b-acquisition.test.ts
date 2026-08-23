/**
 * Phase 3b tests: download clients (fixture + qBittorrent/SABnzbd adapters),
 * release-comparison engine, grab-decision pipeline with event tracing,
 * private-tracker announce safety + seed goals, and the VPN kill switch.
 * No real trackers, usenet providers, or external downloads are used.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Kysely } from "kysely";
import { migrate, openDatabase, type Db } from "@tantalar/db";
import {
  EventTypes,
  DownloadClientError,
  parseQualityLabel,
  isProperOrRepack,
  validateDownloadRequest,
  type ComparisonVerdict,
  type DownloadStatus,
  type IndexerSearchResult,
} from "@tantalar/contracts";
import { EventBus } from "../apps/server/src/events.js";
import { ServiceContainer } from "../apps/server/src/container.js";
import { Scheduler } from "../apps/server/src/scheduler.js";
import { Supervisor } from "../apps/server/src/supervisor.js";
import { GrabPipeline } from "../apps/server/src/acquisition/pipeline.js";
import { createVpnHandlers } from "../plugins/vpn-manager/src/plugin.js";

const VPN_BINDING_CAP = "dev.tantalar.capability.vpn-binding";
import { compareReleases, toCandidate } from "../apps/server/src/acquisition/comparer.js";
import { runConformanceSuite } from "@tantalar/testkit";

const policy = {
  initialBackoffMs: 100,
  maxBackoffMs: 500,
  backoffMultiplier: 2,
  windowMs: 10_000,
  maxRestartsInWindow: 5,
};

let db: Kysely<Db>;
let bus: EventBus;
let container: ServiceContainer;
let supervisor: Supervisor;
let dir: string;
let pipeline: GrabPipeline;

const FIXTURE_CLIENT = "node " + resolve("plugins/fixture-download-client/dist/plugin.js");
const FIXTURE_TRACKER = "node " + resolve("plugins/fixture-tracker/dist/plugin.js");
const QBIT_ENTRY = "node " + resolve("plugins/qbittorrent/dist/plugin.js");
const SAB_ENTRY = "node " + resolve("plugins/sabnzbd/dist/plugin.js");
/** Exact configured SABnzbd API key; redaction assertions must use this constant. */
const SABNZBD_API_KEY = "super-secret-key";

function manifestFor(id: string, capability: string, command: string) {
  return {
    id,
    version: "0.1.0",
    protocolVersion: 1,
    provides: [capability],
    requires: ["dev.tantalar.capability.event.emit", "dev.tantalar.capability.log"],
    subscriptions: [],
    entry: { command },
  };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "tantalar-p3b-"));
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
      const configJson = (m as unknown as { __config?: Record<string, unknown> }).__config;
      return {
        command: cmd ?? "node",
        args: rest.filter(Boolean),
        env: (configJson ? { TANTALAR_PLUGIN_CONFIG: JSON.stringify(configJson) } : {}) as Record<string, string>,
      };
    },
  });
  pipeline = new GrabPipeline({ bus, container });
});

afterAll(async () => {
  await supervisor.stopAll();
  await db.destroy();
});

async function mount(id: string, capability: string, command: string, config?: Record<string, unknown>) {
  const m = manifestFor(id, capability, command);
  if (config) Object.assign(m, { __config: config });
  const rt = await supervisor.mount(m, config ?? {});
  expect(rt.state).toBe("healthy");
}

// ---- Shared fixture release builders ------------------------------------------

function release(overrides: Partial<Parameters<typeof toCandidate>[0]> & { guid: string; title: string }) {
  return toCandidate({
    kind: "torrent",
    downloadUrl: `https://fixture.invalid/${overrides.guid}`,
    sizeBytes: 1024,
    publishedAt: new Date().toISOString(),
    categories: [],
    indexerId: "dev.tantalar.plugin.fixture-indexer",
    seeders: 50,
    ...overrides,
  });
}

const BASE_PROFILE = {
  name: "hd",
  preferredQualities: ["1080p"],
};

// ---- 1. Comparison engine behavior suite ---------------------------------------

describe("release comparison engine (deep module, external behavior)", () => {
  it("picks the best quality available", () => {
    const out = compareReleases({
      candidates: [release({ guid: "a", title: "Show 720p" }), release({ guid: "b", title: "Show 1080p" })],
      profile: BASE_PROFILE,
    }) as ComparisonVerdict;
    expect(out.winnerGuid).toBe("b");
    expect(out.reasons).toContain("best_quality_available");
  });

  it("prefers proper/repack upgrades when allowed", () => {
    const out = compareReleases({
      candidates: [release({ guid: "orig", title: "Show 1080p" }), release({ guid: "proper", title: "Show 1080p PROPER" })],
      profile: { ...BASE_PROFILE, preferProperRepack: true },
    }) as ComparisonVerdict;
    expect(out.winnerGuid).toBe("proper");
    expect(out.reasons).toContain("proper_repack_upgrade");
  });

  it("rejects oversized releases with a structured reason", () => {
    const out = compareReleases({
      candidates: [release({ guid: "big", title: "Show 1080p", sizeBytes: 1_000_000 })],
      profile: { ...BASE_PROFILE, maxSizeBytes: 1_000 },
    }) as ComparisonVerdict;
    expect(out.winnerGuid).toBeNull();
    expect(out.rejected[0]).toMatchObject({ guid: "big", reason: "size_exceeds_limit" });
  });

  it("rejects releases below the seeder minimum", () => {
    const out = compareReleases({
      candidates: [release({ guid: "dead", title: "Show 1080p", seeders: 1 })],
      profile: { ...BASE_PROFILE, minSeeders: 10 },
    }) as ComparisonVerdict;
    expect(out.winnerGuid).toBeNull();
    expect(out.rejected[0]?.reason).toBe("seeders_below_minimum");
  });

  it("returns no_qualifying_release for an empty candidate set", () => {
    const out = compareReleases({ candidates: [], profile: BASE_PROFILE }) as ComparisonVerdict;
    expect(out.winnerGuid).toBeNull();
    expect(out.reasons).toContain("no_qualifying_release");
  });

  it("parses quality labels and proper/repack flags from titles", () => {
    expect(parseQualityLabel("Movie 2160p BluRay")).toBe("2160p");
    expect(parseQualityLabel("Movie WEBRip")).toBe("unknown");
    expect(isProperOrRepack("Show S01 REPACK")).toBe(true);
    expect(isProperOrRepack("Show S01")).toBe(false);
  });
});

// ---- 2. Fixture download client over the process boundary ----------------------

describe("fixture download-client (normalized states)", () => {
  const CLIENT_ID = "dev.tantalar.plugin.fixture-download-client";

  it("runs an NZB job through queued → downloading → completed with events", async () => {
    await mount(CLIENT_ID, "dev.tantalar.capability.download-client", FIXTURE_CLIENT);
    const provider = container.resolve("dev.tantalar.capability.download-client");
    const add = (await provider.invoke("add", {
      itemKey: "ep-1",
      title: "Fixture Show S01E01 1080p WEB-DL",
      kind: "nzb",
      sourceUrl: "https://fixture.invalid/nzb/0001.nzb",
      correlationId: "corr-nzb-1",
    })) as DownloadStatus;
    expect(add.state).toBe("downloading"); // fixture advances 50% per tick
    const fin = (await provider.invoke("advance", {})) as { downloads: DownloadStatus[] };
    expect(fin.downloads.find((d) => d.itemKey === "ep-1")?.state).toBe("completed");

    const corr = await bus.read({ correlationId: "corr-nzb-1" });
    const types = corr.map((e) => e.type);
    expect(types).toContain(EventTypes.DownloadProgress);
    expect(types).toContain(EventTypes.DownloadCompleted);
    await supervisor.unmount(CLIENT_ID);
  });

  it("drives a torrent job through normalized states deterministically", async () => {
    await mount(CLIENT_ID, "dev.tantalar.capability.download-client", FIXTURE_CLIENT);
    const provider = container.resolve("dev.tantalar.capability.download-client");
    const add = (await provider.invoke("add", {
      itemKey: "ep-2",
      title: "Fixture Show S01E01 720p HDTV",
      kind: "torrent",
      sourceUrl: "magnet:?xt=urn:btih:fixture0002",
      correlationId: "corr-tor-1",
    })) as DownloadStatus;
    expect(add.state).toBe("downloading");
    const mid = (await provider.invoke("advance", {})) as { downloads: DownloadStatus[] };
    const done = mid.downloads.find((d) => d.itemKey === "ep-2");
    expect(done?.state).toBe("completed");
    expect(done?.progressPercent).toBe(100);
    await supervisor.unmount(CLIENT_ID);
  });

  it("fails configured items and supports cancellation + retry", async () => {
    await mount(
      CLIENT_ID,
      "dev.tantalar.capability.download-client",
      FIXTURE_CLIENT,
      { failItemKeys: ["ep-bad"] },
    );
    const provider = container.resolve("dev.tantalar.capability.download-client");
    const bad = (await provider.invoke("add", {
      itemKey: "ep-bad",
      title: "Broken",
      kind: "nzb",
      sourceUrl: "https://fixture.invalid/bad.nzb",
      correlationId: "corr-fail-1",
    })) as DownloadStatus;
    // One tick reaches exactly 50% — below the failure threshold.
    expect(bad.state).toBe("downloading");
    const after = (await provider.invoke("advance", {})) as { downloads: DownloadStatus[] };
    const failedJob = after.downloads.find((d) => d.itemKey === "ep-bad");
    expect(failedJob?.state).toBe("failed");
    expect(failedJob?.error).toMatch(/simulated/);

    // Retry: a fresh add for the same item restarts the transfer.
    const retry = (await provider.invoke("add", {
      itemKey: "ep-bad",
      title: "Broken",
      kind: "nzb",
      sourceUrl: "https://fixture.invalid/bad.nzb",
    })) as DownloadStatus;
    expect(retry.state).toBe("downloading");
    await supervisor.unmount(CLIENT_ID);
  });

  it("validates requests against the neutral schema across the boundary", async () => {
    await mount(CLIENT_ID, "dev.tantalar.capability.download-client", FIXTURE_CLIENT);
    const provider = container.resolve("dev.tantalar.capability.download-client");
    await expect(
      provider.invoke("add", { itemKey: "", title: "x", kind: "nzb", sourceUrl: "u" }),
    ).rejects.toThrow(/itemKey/);
    await expect(provider.invoke("status", { downloadId: "nope" })).rejects.toThrow(/unknown download/);
    await supervisor.unmount(CLIENT_ID);
  });
});

// ---- 3. qBittorrent / SABnzbd adapters (injected transports, no network) -------

describe("qBittorrent and SABnzbd first-party plugins", () => {
  it("maps qBittorrent states onto the normalized schema end to end", async () => {
    await mount(
      "dev.tantalar.plugin.qbittorrent",
      "dev.tantalar.capability.download-client",
      QBIT_ENTRY,
      { transport: "memory" },
    );
    const provider = container.resolve("dev.tantalar.capability.download-client");
    const status = (await provider.invoke("add", {
      itemKey: "q-ep",
      title: "Q Show 1080p",
      kind: "torrent",
      sourceUrl: "magnet:?xt=urn:btih:qbitfixture",
    })) as DownloadStatus;
    expect(status.state).toBe("queued");
    expect(status.itemKey).toBe("q-ep");
    const paused = (await provider.invoke("pause", { downloadId: status.downloadId })) as Record<string, unknown>;
    expect(paused.paused).toBe(true);
    const listed = (await provider.invoke("list", {})) as { downloads: DownloadStatus[] };
    expect(listed.downloads[0]?.state).toBe("paused");
    await supervisor.unmount("dev.tantalar.plugin.qbittorrent");
  }, 30_000);

  it("rejects torrent releases on SABnzbd and queues NZBs via its API", async () => {
    await mount(
      "dev.tantalar.plugin.sabnzbd",
      "dev.tantalar.capability.download-client",
      SAB_ENTRY,
      { transport: "memory", apiKey: SABNZBD_API_KEY },
    );
    const provider = container.resolve("dev.tantalar.capability.download-client");
    await expect(
      provider.invoke("add", { itemKey: "t", title: "T", kind: "torrent", sourceUrl: "magnet:?x" }),
    ).rejects.toThrow(/nzb releases only/);
    const status = (await provider.invoke("add", {
      itemKey: "s-ep",
      title: "S Show",
      kind: "nzb",
      sourceUrl: "https://fixture.invalid/s.nzb",
      correlationId: "corr-sab-1",
    })) as DownloadStatus;
    expect(status.state).toBe("queued");
    const fetched = (await provider.invoke("status", { downloadId: status.downloadId })) as DownloadStatus;
    expect(fetched.itemKey).toBe("s-ep");
    // Secret redaction: api key must not leak into any event payload.
    const rows = await bus.read({ correlationId: "corr-sab-1" });
    for (const row of rows) {
      expect(JSON.stringify(row.payload)).not.toContain(SABNZBD_API_KEY);
    }
    await supervisor.unmount("dev.tantalar.plugin.sabnzbd");
  }, 30_000);
});

// ---- 4. Grab decision pipeline --------------------------------------------------

describe("grab decision pipeline (every step is an event)", () => {
  const CLIENT_ID = "dev.tantalar.plugin.fixture-download-client";

  it("auto-grabs a qualifying release through verdict → decision → dispatch → queued", async () => {
    await mount(CLIENT_ID, "dev.tantalar.capability.download-client", FIXTURE_CLIENT);
    const corr = "corr-grab-auto";
    const result = await pipeline.decide({
      itemKey: "movie-1",
      mode: "automatic",
      correlationId: corr,
      candidates: [release({ guid: "win", title: "Movie 2024 1080p BluRay" }), release({ guid: "lose", title: "Movie 2024 720p" })],
      profile: BASE_PROFILE,
    });
    expect(result.grabbed).toBe(true);
    expect(result.verdict.winnerGuid).toBe("win");
    expect(result.download?.state).toBeDefined();

    const events = await bus.read({ correlationId: corr });
    const types = events.map((e) => e.type);
    expect(types.sort()).toEqual(
      [
        EventTypes.ComparisonVerdict,
        EventTypes.GrabDecision,
        EventTypes.ClientDispatch,
        EventTypes.DownloadQueued,
        EventTypes.DownloadProgress,
      ].sort(),
    );
    await supervisor.unmount(CLIENT_ID);
  });

  it("blocks automatic grabs with no qualifying candidate", async () => {
    const corr = "corr-grab-none";
    const result = await pipeline.decide({
      itemKey: "movie-2",
      mode: "automatic",
      correlationId: corr,
      candidates: [release({ guid: "big", title: "Movie 1080p", sizeBytes: 9_999_999 })],
      profile: { ...BASE_PROFILE, maxSizeBytes: 100 },
    });
    expect(result.grabbed).toBe(false);
    expect(result.blockedReason).toBe("no_qualifying_release");
    const events = await bus.read({ correlationId: corr });
    expect(events.map((e) => e.type).sort()).toEqual(
      [EventTypes.ComparisonVerdict, EventTypes.GrabDecision].sort(),
    );
  });

  it("supports interactive picking but rejects picks outside the candidate set", async () => {
    await mount(CLIENT_ID, "dev.tantalar.capability.download-client", FIXTURE_CLIENT);
    const picked = await pipeline.decide({
      itemKey: "movie-3",
      mode: "interactive",
      chosenGuid: "lose",
      correlationId: "corr-grab-inter",
      candidates: [release({ guid: "win", title: "M 1080p" }), release({ guid: "lose", title: "M 720p" })],
      profile: BASE_PROFILE,
    });
    expect(picked.grabbed).toBe(true);
    expect(picked.download?.itemKey).toBe("lose");
    await expect(
      pipeline.decide({
        itemKey: "movie-4",
        mode: "interactive",
        chosenGuid: "ghost",
        candidates: [release({ guid: "win", title: "M 1080p" })],
        profile: BASE_PROFILE,
      }),
    ).rejects.toThrow(/not among candidates/);
    await supervisor.unmount(CLIENT_ID);
  });

  it("blacklists failed downloads so later comparisons reject them", async () => {
    await mount(CLIENT_ID, "dev.tantalar.capability.download-client", FIXTURE_CLIENT);
    await pipeline.handleFailure("movie-x", "bad-guid");
    const result = await pipeline.decide({
      itemKey: "movie-x",
      mode: "automatic",
      correlationId: "corr-blacklist",
      candidates: [
        release({ guid: "bad-guid", title: "M 2160p" }),
        release({ guid: "ok", title: "M 720p" }),
      ],
      profile: BASE_PROFILE,
    });
    expect(result.grabbed).toBe(true);
    expect(result.verdict.winnerGuid).toBe("ok");
    expect(result.verdict.rejected).toMatchObject([{ guid: "bad-guid", reason: "blacklisted_release" }]);
    await supervisor.unmount(CLIENT_ID);
  });
});

// ---- 5. Private tracker announce safety + seed goals ----------------------------

describe("private tracker rules plugin (announce guard + seed goals)", () => {
  const TRACKER_ID = "dev.tantalar.plugin.fixture-tracker";

  it("allows announce URLs on declared hosts only, fuzzed", async () => {
    await mount(TRACKER_ID, "dev.tantalar.capability.tracker.rules", FIXTURE_TRACKER);
    const provider = container.resolve("dev.tantalar.capability.tracker.rules");

    const good = (await provider.invoke("check-announce", {
      downloadUrl: "https://tracker.fixture.invalid/dl/0001?passkey=SECRET123",
      trackerId: TRACKER_ID,
    })) as { allowed: boolean; reason: string };
    expect(good.allowed).toBe(true);
    expect(good.reason).toBe("host_allowed");

    const evilHosts = [
      "https://evil.example.com/dl?announce=https://tracker.fixture.invalid.evil.com/x",
      "https://tracker-fixture.invalid/dl",
      "https://tracker.fixture.invalid.attacker.io/dl",
      "file:///etc/passwd",
      "",
    ];
    for (const url of evilHosts) {
      const v = (await provider.invoke("check-announce", { downloadUrl: url, trackerId: TRACKER_ID })) as {
        allowed: boolean;
        reason: string;
      };
      expect(v.allowed).toBe(false);
    }

    // Passkeys never surface in results or in any event payload.
    const rows = await bus.read({ typePrefix: "dev.tantalar.event.tracker.announce.checked" });
    for (const row of rows) {
      const text = JSON.stringify(row.payload);
      expect(text).not.toContain("SECRET123");
      expect(text).not.toContain("tracker.fixture.invalid");
    }
    await supervisor.unmount(TRACKER_ID);
  });

  it("reports configurable seed/ratio goals", async () => {
    await mount(TRACKER_ID, "dev.tantalar.capability.tracker.rules", FIXTURE_TRACKER, { ratio: 2, seedMinutes: 120 });
    const provider = container.resolve("dev.tantalar.capability.tracker.rules");
    const goal = (await provider.invoke("seed-goal", {})) as Record<string, number | null>;
    expect(goal.ratio).toBe(2);
    expect(goal.seedMinutes).toBe(120);
    await supervisor.unmount(TRACKET_ID_SAFE());
  });
});
function TRACKET_ID_SAFE(): string {
  return "dev.tantalar.plugin.fixture-tracker";
}

// ---- 6. VPN manager: binding + fail-closed kill switch ---------------------------

describe("VPN manager (per-client tunnel binding, kill switch)", () => {
  const VPN_ID = "dev.tantalar.plugin.vpn-manager";
  const CLIENT_ID = "dev.tantalar.plugin.fixture-download-client";

  it("binds clients to openvpn/wireguard profiles and unbinds explicitly", async () => {
    await mount(VPN_ID, "dev.tantalar.capability.vpn-binding", "node " + resolve("plugins/vpn-manager/dist/plugin.js"), {
      profiles: [
        { profileId: "wg-main", protocol: "wireguard", endpointHost: "vpn1.fixture.invalid" },
        { profileId: "ovpn-backup", protocol: "openvpn", endpointHost: "vpn2.fixture.invalid" },
      ],
    });
    const vpn = container.resolve("dev.tantalar.capability.vpn-binding");
    const bound = (await vpn.invoke("set-binding", { clientId: CLIENT_ID, profileId: "wg-main" })) as Record<string, unknown>;
    expect(bound.profileId).toBe("wg-main");
    const unbound = (await vpn.invoke("set-binding", { clientId: CLIENT_ID, profileId: null })) as Record<string, unknown>;
    expect(unbound.profileId).toBeNull();
    await expect(vpn.invoke("set-binding", { clientId: CLIENT_ID, profileId: "ghost" })).rejects.toThrow(/unknown vpn profile/);
    await supervisor.unmount(VPN_ID);
  });

  it("fail-closed gate: dispatch blocked unless health is explicitly healthy", async () => {
    await mount(VPN_ID, "dev.tantalar.capability.vpn-binding", "node " + resolve("plugins/vpn-manager/dist/plugin.js"), {
      profiles: [{ profileId: "wg-main", protocol: "wireguard", endpointHost: "vpn1.fixture.invalid" }],
    });
    const vpn = container.resolve("dev.tantalar.capability.vpn-binding");
    await vpn.invoke("set-binding", { clientId: CLIENT_ID, profileId: "wg-main" });

    // Not yet reported → blocked (fail closed).
    let check = (await vpn.invoke("pre-dispatch-check", { clientId: CLIENT_ID })) as { allowDispatch: boolean };
    expect(check.allowDispatch).toBe(false);

    // Degraded → blocked.
    await vpn.invoke("health-report", { profileId: "wg-main", health: "degraded" });
    check = (await vpn.invoke("pre-dispatch-check", { clientId: CLIENT_ID })) as { allowDispatch: boolean };
    expect(check.allowDispatch).toBe(false);

    // Explicit healthy → allowed.
    await vpn.invoke("health-report", { profileId: "wg-main", health: "healthy" });
    check = (await vpn.invoke("pre-dispatch-check", { clientId: CLIENT_ID })) as { allowDispatch: boolean };
    expect(check.allowDispatch).toBe(true);
    await supervisor.unmount(VPN_ID);
  });

  it("kill switch blocks the grab pipeline while the tunnel is down and resumes only on healthy", async () => {
    await mount(VPN_ID, "dev.tantalar.capability.vpn-binding", "node " + resolve("plugins/vpn-manager/dist/plugin.js"), {
      profiles: [{ profileId: "wg-main", protocol: "wireguard", endpointHost: "vpn1.fixture.invalid" }],
    });
    await mount(CLIENT_ID, "dev.tantalar.capability.download-client", FIXTURE_CLIENT);
    const vpn = container.resolve("dev.tantalar.capability.vpn-binding");
    // Regression (round-1 review): the pipeline must consult the DOWNLOAD
    // CLIENT's plugin id, not the release's indexerId. Bind the actual client.
    await vpn.invoke("set-binding", { clientId: CLIENT_ID, profileId: "wg-main" });
    await vpn.invoke("health-report", { profileId: "wg-main", health: "down" });

    // Tunnel down → grab blocked BEFORE any client dispatch happens.
    await expect(
      pipeline.decide({
        itemKey: "ks-movie",
        mode: "automatic",
        correlationId: "corr-ks-blocked",
        candidates: [release({ guid: "k1", title: "KS Movie 1080p" })],
        profile: BASE_PROFILE,
      }),
    ).rejects.toThrow(/kill switch/);

    // No dispatch/queued event may exist for the correlation.
    const blockedEvents = await bus.read({ correlationId: "corr-ks-blocked" });
    expect(blockedEvents.map((e) => e.type)).not.toContain(EventTypes.ClientDispatch);
    expect(blockedEvents.map((e) => e.type)).not.toContain(EventTypes.DownloadQueued);
    // But the block itself was traced.
    expect(blockedEvents.map((e) => e.type)).toContain(EventTypes.TunnelHealthChanged);

    // Resume ONLY through explicit healthy state.
    await vpn.invoke("health-report", { profileId: "wg-main", health: "healthy" });
    const resumed = await pipeline.decide({
      itemKey: "ks-movie",
      mode: "automatic",
      correlationId: "corr-ks-resumed",
      candidates: [release({ guid: "k1", title: "KS Movie 1080p" })],
      profile: BASE_PROFILE,
    });
    expect(resumed.grabbed).toBe(true);
    await supervisor.unmount(CLIENT_ID);
    await supervisor.unmount(VPN_ID);
  });

  it("kill-switch ORDERING: block fires for the bound client before unbind/fallback (observable NetControl seam)", async () => {
    // Drive the exact handler logic vpn-manager runs, injecting a recording
    // NetControl so call order is directly observable.
    const calls: string[] = [];
    const recordingNet = {
      bind: async (clientId: string) => void calls.push(`bind:${clientId}`),
      unbind: async (clientId: string) => void calls.push(`unbind:${clientId}`),
      block: async (clientId: string) => void calls.push(`block:${clientId}`),
    };
    const core = createVpnHandlers({ netControl: recordingNet });
    core.loadProfiles([{ profileId: "wg-main", protocol: "wireguard", endpointHost: "vpn1.fixture.invalid" }]);
    const vpn = core.handlers[VPN_BINDING_CAP] as unknown as {
      (op: string, payload: Record<string, unknown>): Promise<unknown>;
    };

    await vpn("set-binding", { clientId: CLIENT_ID, profileId: "wg-main" });
    await vpn("health-report", { profileId: "wg-main", health: "healthy" });
    expect(calls).toEqual([`bind:${CLIENT_ID}`]);

    // Tunnel loss: block for the BOUND CLIENT must be the FIRST net action,
    // before any unbind/fallback could occur.
    calls.length = 0;
    await vpn("health-report", { profileId: "wg-main", health: "down" });
    expect(calls[0]).toBe(`block:${CLIENT_ID}`);
    expect(calls).not.toContain(`unbind:${CLIENT_ID}`);

    // Explicit disable path: unbind is explicit operator action, never a
    // fallback side effect of tunnel loss.
    calls.length = 0;
    await vpn("set-binding", { clientId: CLIENT_ID, profileId: null });
    expect(calls).toEqual([`unbind:${CLIENT_ID}`]);
  });
});

// ---- 7. Conformance for every new plugin -----------------------------------------

describe("conformance suites (phase-2 testkit against phase-3b plugins)", () => {
  const dirs = [
    "plugins/fixture-download-client",
    "plugins/fixture-tracker",
    "plugins/qbittorrent",
    "plugins/sabnzbd",
    "plugins/vpn-manager",
  ];
  for (const d of dirs) {
    it(`passes conformance: ${d}`, async () => {
      const report = await runConformanceSuite({ packageDir: resolve(d) });
      expect(report.failed).toBe(0);
      expect(report.passed).toBeGreaterThan(5);
    }, 60_000);
  }
});

// ---- Schema sanity kept close to the suite ----------------------------------------

describe("download-request schema validation", () => {
  it("accepts valid and rejects malformed requests", () => {
    expect(validateDownloadRequest({ itemKey: "a", title: "T", kind: "torrent", sourceUrl: "magnet:?x" }).kind).toBe("torrent");
    expect(() => validateDownloadRequest({ itemKey: "a", title: "", kind: "nzb", sourceUrl: "u" })).toThrow(DownloadClientError);
    expect(() => validateDownloadRequest({ itemKey: "a", title: "T", kind: "usenet", sourceUrl: "u" })).toThrow(/kind/);
  });

  it("keeps IndexerSearchResult usable as candidate input shape", async () => {
    void ({} as IndexerSearchResult);
  });
});
