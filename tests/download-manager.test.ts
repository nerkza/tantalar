import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DownloadJobStore, migrate, openDatabase, type Db } from "@tantalar/db";
import type { Kysely } from "kysely";
import { ServiceContainer } from "../apps/server/src/container.js";
import { syncDownloadJobs } from "../apps/server/src/download-manager.js";
import { DownloadClientError } from "@tantalar/contracts";

describe("source-aware download synchronization", () => {
  let db: Kysely<Db> | null = null;
  afterEach(async () => db?.destroy());

  it("polls each durable job through its recorded provider identity", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tantalar-download-sync-"));
    db = await openDatabase({ dialect: "sqlite", sqlitePath: join(dir, "test.db") });
    await migrate(db);
    const jobs = new DownloadJobStore(db);
    const torrent = await jobs.create({
      itemKey: "torrent.item",
      title: "Torrent item",
      source: "torrent",
      providerPluginId: "dev.tantalar.plugin.torrent-native",
      providerJobId: "torrent-provider-job",
      sourceRef: `sha256:${"a".repeat(64)}`,
    });
    const usenet = await jobs.create({
      itemKey: "usenet.item",
      title: "Usenet item",
      source: "usenet",
      providerPluginId: "dev.tantalar.plugin.usenet-native",
      providerJobId: "usenet-provider-job",
      sourceRef: `sha256:${"b".repeat(64)}`,
    });
    const seen: string[] = [];
    const container = new ServiceContainer();
    for (const [pluginId, expectedId, percent] of [
      ["dev.tantalar.plugin.torrent-native", "torrent-provider-job", 25],
      ["dev.tantalar.plugin.usenet-native", "usenet-provider-job", 60],
    ] as const) {
      container.register({
        pluginId,
        capability: "dev.tantalar.capability.download-client",
        invoke: async (_operation, payload) => {
          seen.push(String(payload.downloadId));
          return {
            downloadId: expectedId,
            itemKey: pluginId.includes("torrent") ? "torrent.item" : "usenet.item",
            state: "downloading",
            progressPercent: percent,
            sizeBytes: 1000,
            ...(pluginId.includes("usenet") ? { receivedBytes: 604 } : {}),
          };
        },
      });
    }

    expect(await syncDownloadJobs(jobs, container)).toBe(2);
    expect(seen.sort()).toEqual(["torrent-provider-job", "usenet-provider-job"]);
    expect((await jobs.get(torrent.record.jobId))?.receivedBytes).toBe(250);
    expect((await jobs.get(usenet.record.jobId))?.receivedBytes).toBe(604);
  });

  it("persists useful failure details without retaining provider secrets", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tantalar-download-failure-"));
    db = await openDatabase({ dialect: "sqlite", sqlitePath: join(dir, "test.db") });
    await migrate(db);
    const jobs = new DownloadJobStore(db);
    const { record } = await jobs.create({ itemKey: "missing.item", title: "Missing item", source: "usenet", providerPluginId: "provider-failed", providerJobId: "failed-job", sourceRef: `sha256:${"a".repeat(64)}` });
    const container = new ServiceContainer();
    container.register({ pluginId: "provider-failed", capability: "dev.tantalar.capability.download-client", invoke: async () => ({ downloadId: "failed-job", itemKey: "missing.item", state: "failed", progressPercent: 5, sizeBytes: 1000, error: "segment private-key unavailable on all configured servers" }) });
    await syncDownloadJobs(jobs, container);
    const failed = await jobs.get(record.jobId);
    expect(failed?.state).toBe("failed");
    expect(failed?.receivedBytes).toBe(50);
    expect(failed?.failureReason).toBe("A Usenet article is missing on all configured servers. Search for another release or add a fill server.");
    expect(failed?.failureReason).not.toContain("private-key");
    await jobs.updateProgress(record.jobId, { state: "downloading" });
    expect((await jobs.get(record.jobId))?.failureReason).toBeNull();
  });

  it("retries a completed import handoff until it records the destination", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tantalar-download-handoff-"));
    db = await openDatabase({ dialect: "sqlite", sqlitePath: join(dir, "test.db") });
    await migrate(db);
    const jobs = new DownloadJobStore(db);
    const created = await jobs.create({
      itemKey: "movie-handoff",
      title: "Movie Handoff 1080p",
      source: "torrent",
      providerPluginId: "provider-completed",
      providerJobId: "completed-job",
      sourceRef: `sha256:${"9".repeat(64)}`,
      correlationId: "operation-handoff",
    });
    const container = new ServiceContainer();
    container.register({
      pluginId: "provider-completed",
      capability: "dev.tantalar.capability.download-client",
      invoke: async () => ({
        downloadId: "completed-job",
        itemKey: "movie-handoff",
        state: "completed",
        progressPercent: 100,
        sizeBytes: 1000,
      }),
    });
    let attempts = 0;
    const handoff = async (job: { correlationId: string | null }) => {
      expect(job.correlationId).toBe("operation-handoff");
      attempts++;
      if (attempts === 1) throw new Error("import unavailable");
      return "/library/Movie Handoff.mkv";
    };

    expect(await syncDownloadJobs(jobs, container, handoff)).toBe(1);
    expect((await jobs.getOrThrow(created.record.jobId)).importHandoffPath).toBeNull();
    expect(await syncDownloadJobs(jobs, container, handoff)).toBe(1);
    expect((await jobs.getOrThrow(created.record.jobId)).importHandoffPath).toBe("/library/Movie Handoff.mkv");
    expect(attempts).toBe(2);
  });

  it("rejects malformed provider state, redacts outages, and reconciles removed engine jobs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tantalar-download-sync-errors-"));
    db = await openDatabase({ dialect: "sqlite", sqlitePath: join(dir, "test.db") });
    await migrate(db);
    const jobs = new DownloadJobStore(db);
    const malformed = await jobs.create({
      itemKey: "malformed.item",
      title: "Malformed",
      source: "torrent",
      providerPluginId: "provider-malformed",
      providerJobId: "malformed-job",
      sourceRef: `sha256:${"c".repeat(64)}`,
    });
    const outage = await jobs.create({
      itemKey: "outage.item",
      title: "Outage",
      source: "usenet",
      providerPluginId: "provider-outage",
      providerJobId: "outage-job",
      sourceRef: `sha256:${"d".repeat(64)}`,
    });
    const removed = await jobs.create({
      itemKey: "removed.item",
      title: "Removed",
      source: "usenet",
      providerPluginId: "provider-removed",
      providerJobId: "removed-job",
      sourceRef: `sha256:${"e".repeat(64)}`,
    });
    await jobs.updateProgress(removed.record.jobId, { state: "paused" });
    const drifted = await jobs.create({
      itemKey: "drifted.item",
      title: "Drifted",
      source: "torrent",
      providerPluginId: "provider-drifted",
      providerJobId: "drifted-job",
      sourceRef: `sha256:${"f".repeat(64)}`,
    });
    await jobs.updateProgress(drifted.record.jobId, { state: "paused" });
    const container = new ServiceContainer();
    container.register({
      pluginId: "provider-malformed",
      capability: "dev.tantalar.capability.download-client",
      invoke: async () => ({ downloadId: "malformed-job", itemKey: "malformed.item", state: "downloading", progressPercent: Number.NaN, sizeBytes: 1 }),
    });
    container.register({
      pluginId: "provider-outage",
      capability: "dev.tantalar.capability.download-client",
      invoke: async () => { throw new Error("https://tracker.invalid/private-passkey/announce"); },
    });
    container.register({
      pluginId: "provider-removed",
      capability: "dev.tantalar.capability.download-client",
      invoke: async () => { throw new DownloadClientError("unknown_download", "unknown download"); },
    });
    container.register({
      pluginId: "provider-drifted",
      capability: "dev.tantalar.capability.download-client",
      invoke: async () => ({ downloadId: "drifted-job", itemKey: "drifted.item", state: "downloading", progressPercent: 12, sizeBytes: 100 }),
    });

    expect(await syncDownloadJobs(jobs, container)).toBe(2);
    const malformedAfter = await jobs.getOrThrow(malformed.record.jobId);
    const outageAfter = await jobs.getOrThrow(outage.record.jobId);
    expect(malformedAfter.progressPercent).toBe(0);
    expect(malformedAfter.warnings).toEqual(["Download provider status unavailable."]);
    expect(outageAfter.warnings).toEqual(["Download provider status unavailable."]);
    expect(JSON.stringify(outageAfter)).not.toContain("private-passkey");
    expect((await jobs.getOrThrow(removed.record.jobId)).removed).toBe(true);
    expect((await jobs.getOrThrow(drifted.record.jobId)).state).toBe("downloading");
  });
});
