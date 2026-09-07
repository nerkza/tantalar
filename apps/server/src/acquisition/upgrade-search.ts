import { stat } from "node:fs/promises";
import { PluginDocumentStore, type Db, type DownloadJobStore, type ReleaseDecisionStore, humanReason } from "@tantalar/db";
import type { Kysely } from "kysely";
import type { ServiceContainer } from "../container.js";
import type { EventBus } from "../events.js";
import { safeJobError, type JobResult } from "../scheduler.js";
import { type QualitySettings } from "../quality-settings.js";
import { searchManagedReleases } from "./managed-search.js";
import { GrabPipeline } from "./pipeline.js";

/** Bounded upgrade pass over installed, monitored media; completed downloads do not block future upgrades. */
export async function runUpgradeSearch(db: Kysely<Db>, container: ServiceContainer, jobs: DownloadJobStore, decisions: ReleaseDecisionStore, bus: EventBus, quality: QualitySettings, runId: string): Promise<JobResult> {
  const store = new PluginDocumentStore(db);
  const cursor = (await store.get("dev.tantalar.core.jobs", "upgrade-cursor"))?.doc;
  const base = db.selectFrom("media_catalog").selectAll().orderBy("fileId");
  let files = await (typeof cursor === "string" ? base.where("fileId", ">", cursor) : base).limit(20).execute();
  if (!files.length && cursor) files = await base.limit(20).execute();
  const active = new Set((await jobs.list()).filter(j => !j.removed && (j.state === "completed" ? !j.importHandoffPath : !["failed", "cancelled"].includes(j.state))).map(j => j.itemKey));
  const pipeline = new GrabPipeline({ bus, container, jobs });
  let searched = 0, grabbed = 0, skipped = 0, failed = 0;
  const reasons: string[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    try {
      if (seen.has(file.itemKey) || active.has(file.itemKey) || file.itemKey.startsWith("existing:")) { skipped++; continue; }
      seen.add(file.itemKey);
      if (!(await stat(file.path)).isFile()) { skipped++; reasons.push("Installed file is unavailable. Rescan its library."); continue; }
      const episode = /^(.*):(S\d{2,3}E\d{2,4})$/.exec(file.itemKey);
      const kind = episode ? "series" : "movie";
      const id = episode?.[1] ?? file.itemKey;
      const record = await container.resolve(`dev.tantalar.capability.automation.${kind === "movie" ? "movies" : "series"}`).invoke(kind === "movie" ? "get-movie" : "get-series", kind === "movie" ? { movieId: id } : { seriesId: id }) as Record<string, unknown>;
      const library = await db.selectFrom("libraries").select("enabled").where("id", "=", file.libraryId).executeTakeFirst();
      if (!record.monitored || !library?.enabled || record.destinationLibraryId !== file.libraryId) { skipped++; continue; }
      const result = await searchManagedReleases(container, decisions, kind, id, "automatic", episode?.[2], bus, undefined, runId, quality);
      searched++;
      if (result.failures.length && !result.candidates.length) { failed++; reasons.push("Indexer search failed. Check Acquisition → Indexers."); continue; }
      if (!result.context.availabilityMet) { skipped++; reasons.push("Availability threshold has not been reached."); continue; }
      const dispatch = await pipeline.decide({ itemKey: file.itemKey, candidates: result.candidates, profile: result.context.profile, blacklistedGuids: result.blacklistedGuids, mode: "automatic", correlationId: runId });
      const candidate = result.candidates.find(c => c.release.guid === dispatch.verdict.winnerGuid) ?? result.candidates[0];
      if (candidate) await decisions.record({ itemKey: file.itemKey, mode: "automatic", outcome: dispatch.grabbed ? "accepted" : "rejected", guid: candidate.release.guid, title: candidate.release.title,
        reasons: (dispatch.grabbed ? dispatch.verdict.reasons : [dispatch.blockedReason ?? "no_qualifying_release"]).map(r => humanReason(r, { quality: candidate.quality })) });
      if (dispatch.grabbed) { grabbed++; active.add(file.itemKey); }
      else { skipped++; reasons.push(`${String(record.title ?? record.name)}: ${humanReason(dispatch.blockedReason ?? "no_qualifying_release")}`); }
    } catch (error) { failed++; reasons.push(safeJobError(error)); }
    finally { await store.put("dev.tantalar.core.jobs", "upgrade-cursor", file.fileId); }
  }
  return { state: failed ? searched ? "partial" : "blocked" : files.length ? "succeeded" : "skipped", outcome: `${searched} searched, ${grabbed} upgrades grabbed, ${skipped} skipped, ${failed} failed.`, counts: { searched, grabbed, skipped, failed }, reasons };
}
