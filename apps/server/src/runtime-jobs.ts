import { PluginDocumentStore, type Db } from "@tantalar/db";
import { EventTypes } from "@tantalar/contracts";
import type { Kysely } from "kysely";
import type { ServiceContainer } from "./container.js";
import type { LibraryService } from "./library.js";
import type { EventBus } from "./events.js";
import { refreshManagedMetadata } from "./managed-metadata-refresh.js";
import { safeJobError, type Scheduler } from "./scheduler.js";
import { FileMaintenance } from "./file-maintenance.js";

export async function registerLibraryJobs(scheduler: Scheduler, library: LibraryService, container: ServiceContainer, bus: EventBus, db: Kysely<Db>) {
  const cursors = new PluginDocumentStore(db);
  const maintenance = new FileMaintenance(db, library, container, scheduler, bus);
  const declare = async () => {
    const libraries = await library.list();
    for (const lib of libraries) {
      const owner = `core.library.${lib.id}`;
      await scheduler.declareJob(owner, "rename", "every 24h", ({ runId, input }) => maintenance.run(lib.id, "rename", runId, typeof input?.planToken === "string" ? input.planToken : undefined),
        { name: "Rename files", scope: lib.name, enabled: false, manualOnly: true, resource: `library:${lib.id}` });
      await scheduler.declareJob(owner, "recycle-cleanup", "daily 04:30", ({ runId, input }) => maintenance.run(lib.id, "recycle", runId, typeof input?.planToken === "string" ? input.planToken : undefined),
        { name: "Recycle-bin cleanup", scope: lib.name, resource: `library:${lib.id}` });
      await scheduler.declareJob(owner, "scan", "every 12h", async ({ runId }) => {
        if (!(await library.get(lib.id)).enabled) return { state: "skipped", outcome: "Library is disabled." };
        const { errors, ...counts } = await library.rescan(lib.id, runId);
        return { state: errors.length ? "partial" : "succeeded", outcome: `${counts.checked} checked, ${counts.discovered} added, ${counts.missingRemoved} missing records removed, ${errors.length} errors.`, counts, reasons: errors };
      }, { name: "Library scan", scope: lib.name, resource: `library:${lib.id}` });
      await scheduler.declareJob(owner, "metadata-refresh", "daily 03:00", async ({ runId }) => {
        if (!(await library.get(lib.id)).enabled) return { state: "skipped", outcome: "Library is disabled." };
        if (!container.hasProviders("dev.tantalar.capability.metadata-provider")) return { state: "blocked", outcome: "Metadata provider is unavailable. Check Media → Metadata." };
        const items: Array<{ id: string; kind: "movie" | "series" }> = [];
        for (const kind of ["movie", "series"] as const) {
          const capability = `dev.tantalar.capability.automation.${kind === "movie" ? "movies" : "series"}`;
          if (!container.hasProviders(capability)) continue;
          const result = await container.resolve(capability).invoke(kind === "movie" ? "list-movies" : "list-series", {}) as { movies?: Record<string, unknown>[]; series?: Record<string, unknown>[] };
          for (const row of (kind === "movie" ? result.movies : result.series) ?? []) {
            const id = row[kind === "movie" ? "movieId" : "seriesId"] ?? row.id;
            if (row.destinationLibraryId === lib.id && typeof id === "string") items.push({ id, kind });
          }
        }
        items.sort((a, b) => a.id.localeCompare(b.id));
        const cursor = (await cursors.get(owner, "metadata-cursor"))?.doc;
        const ordered = [...items.filter(i => typeof cursor !== "string" || i.id > cursor), ...items.filter(i => typeof cursor === "string" && i.id <= cursor)].slice(0, 50);
        let refreshed = 0, blocked = 0;
        const reasons: string[] = [];
        for (const item of ordered) {
          try {
            await refreshManagedMetadata(container, item.kind, item.id);
            refreshed++;
            await bus.publish({ type: "dev.tantalar.event.job.metadata.refreshed", producer: "dev.tantalar.core.scheduler", subject: item.id, correlationId: runId, payload: { kind: item.kind } });
          } catch (error) { blocked++; reasons.push(`${item.id}: ${safeJobError(error)}`); }
          await cursors.put(owner, "metadata-cursor", item.id);
        }
        return { state: blocked ? refreshed ? "partial" : "blocked" : ordered.length ? "succeeded" : "skipped", outcome: `${refreshed} refreshed, ${blocked} require attention, ${Math.max(0, items.length - ordered.length)} deferred.`, counts: { refreshed, blocked, deferred: Math.max(0, items.length - ordered.length) }, reasons };
      }, { name: "Metadata refresh", scope: lib.name, resource: `library:${lib.id}` });
    }
    const valid = new Set(libraries.map(l => `core.library.${l.id}`));
    for (const job of await scheduler.listJobs()) if (job.pluginId.startsWith("core.library.") && !valid.has(job.pluginId)) await scheduler.removeJobsFor(job.pluginId);
  };
  await declare();
  let pending = Promise.resolve();
  const off = bus.subscribe("dev.tantalar.event.library.", event => {
    if (![EventTypes.LibraryCreated, EventTypes.LibraryEdited, EventTypes.LibraryRemoved].includes(event.type as never)) return;
    pending = pending.catch(() => undefined).then(declare);
    return pending;
  });
  await scheduler.declareJob("core", "history-cleanup", "daily 04:00", async () => {
    const removed = await scheduler.pruneHistory();
    return { outcome: `${removed} completed run records older than 30 days removed. Media files are unchanged.`, counts: { removed } };
  }, { name: "Run history cleanup", scope: "Completed job records · 30 days" });
  return async () => { off(); await pending; };
}
