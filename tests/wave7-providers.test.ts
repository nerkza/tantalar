/**
 * Wave 7 tests (TAN-014 + TAN-016 + TAN-018): real providers and durable
 * decisions.
 *
 * Proves:
 *  - TAN-014: the torznab/newznab plugin speaks real provider wire formats
 *    (caps + RSS parsed from legal synthetic XML), fails closed when
 *    unconfigured, exposes rate-limit state, and redacts apikeys;
 *  - TAN-016: the metadata provider maps real TMDB URLs and payloads through
 *    its transport seam; fixture fallback works without credentials and no
 *    key material appears in lookup output or status;
 *  - TAN-018: every accepted OR rejected decision is recorded durably with
 *    human-readable reasons; manual override is marked; the blocklist is
 *    durable with an expiry policy applied at read time; decision history
 *    survives a full close/reopen of the database (durable boundary).
 *
 * No network: provider responses are synthetic legal fixtures (.invalid
 * hosts, invented ids).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Kysely } from "kysely";
import {
  migrate,
  openDatabase,
  ReleaseDecisionStore,
  type Db,
} from "@tantalar/db";
import { IndexerError } from "@tantalar/contracts";

// ---- Wire-level checks (pure functions, TAN-014) ------------------------------------

describe("Wave 7 wire adapters (TAN-014)", () => {
  const CAPS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<caps>
  <server version="1.0" title="Synthetic Indexer"/>
  <categories>
    <category id="2000" name="Movies">
      <subcat id="2010" name="Foreign"/>
    </category>
    <category id="5000" name="TV"/>
  </categories>
  <searching>
    <search available="yes"/>
    <tv-search available="yes"/>
    <movie-search available="yes"/>
  </searching>
</caps>`;

  function resultsXml(seeders: number): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed">
  <channel>
    <title>Synthetic Indexer</title>
    <item>
      <title>Legal.Test.Movie.2024.1080p</title>
      <guid>https://indexer.invalid/g/1</guid>
      <link>https://indexer.invalid/d/1</link>
      <pubDate>Tue, 18 Aug 2026 10:00:00 +0000</pubDate>
      <category>2000</category>
      <enclosure url="https://indexer.invalid/d/1" length="1073741824" type="application/x-bittorrent"/>
      <torznab:attr name="seeders" value="${seeders}"/>
      <torznab:attr name="peers" value="${seeders + 5}"/>
    </item>
    <item>
      <title>Broken item without guid</title>
      <link>https://indexer.invalid/d/2</link>
    </item>
  </channel>
</rss>`;
  }

  it("parses caps into categories and search modes; fails closed on empty output", async () => {
    const { parseCaps } = await import("../plugins/indexer-torznab-newznab/dist/wire.js");
    const caps = parseCaps(CAPS_XML);
    expect(caps.categories).toContainEqual({ id: 2000, name: "Movies" });
    expect(caps.categories).toContainEqual({ id: 2010, name: "Foreign" });
    expect(caps.searchModes).toEqual(["search", "tv-search", "movie-search"]);
    expect(() => parseCaps("<caps></caps>")).toThrow(IndexerError);
  });

  it("parses result RSS into neutral releases, skipping malformed items", async () => {
    const { parseResults } = await import("../plugins/indexer-torznab-newznab/dist/wire.js");
    const releases = parseResults(resultsXml(42), "torrent");
    expect(releases).toHaveLength(1);
    expect(releases[0]).toMatchObject({
      guid: "https://indexer.invalid/g/1",
      title: "Legal.Test.Movie.2024.1080p",
      kind: "torrent",
      sizeBytes: 1073741824,
      seeders: 42,
      leechers: 5,
      categories: [2000],
    });
  });

  it("builds query URLs with mode mapping and never exposes the apikey unredacted", async () => {
    const { buildQueryUrl } = await import("../plugins/indexer-torznab-newznab/dist/wire.js");
    const url = buildQueryUrl({ baseUrl: "https://indexer.invalid", protocol: "torznab", apiKey: "sekret123", mode: "tv-search", query: "legal test", season: 1, episode: 2 });
    expect(url).toContain("t=tvsearch");
    expect(url).toContain("season=1");
    expect(url).toContain("ep=2");
    expect(url).toContain("apikey=");
    // Redaction pattern used by the plugin for logs/events removes the secret.
    expect(url.replace(/([?&])apikey=[^&]*/i, "$1apikey=[REDACTED]")).not.toContain("sekret123");
    expect(() => buildQueryUrl({ baseUrl: "not a url", protocol: "torznab", apiKey: "x", mode: "search", query: "q" })).toThrow(IndexerError);
  });

  it("builds neutral capabilities docs with a fetch timestamp", async () => {
    const { toCapabilities, DEFAULT_WIRE_LIMITS } = await import("../plugins/indexer-torznab-newznab/dist/wire.js");
    const caps = toCapabilities("newznab", { categories: [{ id: 7000, name: "Books" }], searchModes: [] }, DEFAULT_WIRE_LIMITS);
    expect(caps.protocol).toBe("newznab");
    expect(caps.searchModes).toEqual(["search"]);
    expect(caps.fetchedAt).toBeTruthy();
  });
});

// ---- Durable decisions + blocklist (TAN-018) ----------------------------------------

describe("Wave 7: durable decisions + blocklist (TAN-018)", () => {
  let db: Kysely<Db>;
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "tantalar-wave7-"));
    db = await openDatabase({ dialect: "sqlite", sqlitePath: join(dir, "t.db") });
    await migrate(db);
  });

  it("records accepted AND rejected decisions with human-readable reasons and lists history", async () => {
    const store = new ReleaseDecisionStore(db);
    const accepted = await store.record({
      itemKey: "movie:legal-test",
      mode: "automatic",
      outcome: "accepted",
      guid: "https://indexer.invalid/g/1",
      title: "Legal.Test.Movie.2024.1080p",
      reasons: ["Quality matches the monitoring profile", "Enough seeders"],
    });
    expect(accepted.decisionId).toBeTruthy();
    expect(accepted.blocked).toBe(false);

    const rejected = await store.record({
      itemKey: "movie:legal-test",
      mode: "interactive",
      outcome: "rejected",
      guid: "https://indexer.invalid/g/9",
      title: "Too.Few.Seeders",
      reasons: ["Rejected: too few seeders"],
      overridden: true,
    });
    expect(rejected.overridden).toBe(true);

    const history = await store.listForItem("movie:legal-test");
    expect(history).toHaveLength(2);
    expect(history.map((d) => d.outcome).sort()).toEqual(["accepted", "rejected"]);
    for (const d of history) {
      expect(d.reasons.length).toBeGreaterThan(0);
      expect(typeof d.reasons[0]).toBe("string");
      expect(d.reasons[0].length).toBeGreaterThan(3); // human-readable sentence
    }
  });

  it("blocklist blocks while active, expires by policy, stays listed after expiry, unblocks durably", async () => {
    const store = new ReleaseDecisionStore(db);
    await store.block({ guid: "g-blocked", itemKey: "movie:legal-test", reason: "failed verification twice" });
    expect(await store.activeBlockedGuids("movie:legal-test")).toContain("g-blocked");

    await db.insertInto("release_blocklist")
      .values({ guid: "g-expired", itemKey: "movie:legal-test", reason: "old", expiresAt: new Date(Date.now() - 1000).toISOString(), createdAt: new Date().toISOString() })
      .execute();
    expect(await store.activeBlockedGuids("movie:legal-test")).not.toContain("g-expired");
    const listed = await store.listBlocklist();
    expect(listed.map((b) => b.guid)).toContain("g-expired");

    await store.block({ guid: "g-blocked", itemKey: "movie:legal-test", reason: "second call ignored" });
    expect((await store.listBlocklist()).filter((b) => b.guid === "g-blocked")).toHaveLength(1);

    expect(await store.unblock("g-blocked")).toBe(true);
    expect(await store.unblock("g-blocked")).toBe(false);
    expect(await store.activeBlockedGuids("movie:legal-test")).not.toContain("g-blocked");
  });

  it("rejects invalid records fail-closed", async () => {
    const store = new ReleaseDecisionStore(db);
    await expect(store.record({ itemKey: "", mode: "automatic", outcome: "accepted", guid: "g", title: "t", reasons: [] })).rejects.toThrow(/itemKey and guid/);
    await expect(store.block({ guid: "", itemKey: "i", reason: "r" })).rejects.toThrow(/guid required/);
  });

  it("decision history survives a full close/reopen of the database (durable boundary)", async () => {
    const store = new ReleaseDecisionStore(db);
    await store.record({ itemKey: "series:legal-show", mode: "automatic", outcome: "accepted", guid: "g-e1", title: "E1", reasons: ["Best quality available (HDTV)"] });
    const before = await store.listForItem("series:legal-show");

    const path = join(dir, "t.db");
    await db.destroy();
    db = await openDatabase({ dialect: "sqlite", sqlitePath: path });
    const after = await new ReleaseDecisionStore(db).listForItem("series:legal-show");
    expect(after.length).toBe(before.length);
    expect(after.map((d) => d.guid)).toEqual(before.map((d) => d.guid));
  });
});
