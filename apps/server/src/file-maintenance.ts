import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { extname, relative, sep } from "node:path";
import { PluginDocumentStore, type Db } from "@tantalar/db";
import type { Kysely } from "kysely";
import type { ServiceContainer } from "./container.js";
import type { LibraryService } from "./library.js";
import type { Scheduler, JobResult } from "./scheduler.js";
import { safeJobError } from "./scheduler.js";
import { QualitySettings } from "./quality-settings.js";
import type { EventBus } from "./events.js";

interface RenameItem { fileId: string; source: string; destination: string; fingerprint: string; error?: string }
interface RecycleItem { id: string; name: string; recycledAt: string; size: number; expired: boolean; fingerprint: string }
interface Plan { token: string; kind: "rename" | "recycle"; libraryId: string; createdAt: string; root: string; items: RenameItem[]; entries: RecycleItem[] }
const owner = "dev.tantalar.core.file-plans";
const fingerprint = (s: Awaited<ReturnType<typeof lstat>>) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}`;

export class FileMaintenance {
  private readonly store: PluginDocumentStore;
  constructor(private readonly db: Kysely<Db>, private readonly library: LibraryService, private readonly container: ServiceContainer, private readonly scheduler: Scheduler, private readonly bus: EventBus) { this.store = new PluginDocumentStore(db); }
  private async importer() {
    const provider = this.container.resolve("dev.tantalar.capability.importer");
    if (provider.pluginId !== "dev.tantalar.plugin.library") throw new Error("File maintenance requires the Tantalar library provider.");
    await provider.invoke("configure-roots", { importRoots: (await this.library.list()).filter(l => l.enabled).map(l => l.rootPath) });
    return provider;
  }
  async preview(libraryId: string, kind: "rename" | "recycle", scheme = "default", page = 1) {
    const lib = await this.library.get(libraryId);
    if (!lib.enabled) throw new Error("Library is disabled.");
    const root = await realpath(lib.rootPath);
    const provider = await this.importer();
    const plan: Plan = { token: randomUUID(), kind, libraryId, root, createdAt: new Date().toISOString(), items: [], entries: [] };
    if (kind === "recycle") {
      const settings = await new QualitySettings(this.db).read();
      plan.entries = ((await provider.invoke("recycle-preview", { root, days: settings.recycleBinDays })) as { entries: RecycleItem[] }).entries;
    } else {
      const files = await this.db.selectFrom("media_catalog").selectAll().where("libraryId", "=", libraryId).orderBy("fileId").limit(100).offset((page - 1) * 100).execute();
      const destinations = new Set<string>();
      for (const file of files) {
        const item: RenameItem = { fileId: file.fileId, source: file.path, destination: file.path, fingerprint: "" };
        try {
          const info = await lstat(file.path);
          if (info.isSymbolicLink() || !info.isFile() || !((await realpath(file.path)).startsWith(root + sep))) throw new Error("File is outside the library or is a symlink.");
          item.fingerprint = fingerprint(info);
          if (file.itemKey.startsWith("existing:")) throw new Error("Identify this file before renaming it.");
          const episode = /^(.*):(S(\d{2,3})E(\d{2,4}))$/.exec(file.itemKey);
          const mediaKind = episode ? "series" : "movie", id = episode?.[1] ?? file.itemKey;
          const record = await this.container.resolve(`dev.tantalar.capability.automation.${episode ? "series" : "movies"}`).invoke(episode ? "get-series" : "get-movie", episode ? { seriesId: id } : { movieId: id }) as Record<string, unknown>;
          const episodeRecord = Array.isArray(record.episodes) ? record.episodes.find(e => e.episodeKey === episode?.[2]) : undefined;
          const result = await provider.invoke("preview-rename", { scheme, destinationRoot: root, kind: mediaKind, title: episode ? episodeRecord?.title ?? episode[2] : record.title,
            series: record.name, year: record.year, quality: file.quality, ext: extname(file.path), ...(episode ? { season: Number(episode[3]), episode: Number(episode[4]) } : {}) }) as { path: string };
          item.destination = result.path;
          if (!result.path.startsWith(root + sep) || relative(root, result.path).split(sep).includes("..")) throw new Error("Destination escapes its library.");
          if (destinations.has(result.path)) throw new Error("Two files map to the same destination.");
          destinations.add(result.path);
          if (result.path !== file.path) {
            const target = await lstat(result.path).catch(error => { if (error.code === "ENOENT") return null; throw error; });
            if (target) throw new Error("Destination already exists.");
          }
        } catch (error) { item.error = safeJobError(error); }
        plan.items.push(item);
      }
    }
    await this.store.put(owner, plan.token, plan);
    return { ...plan, root: undefined, items: plan.items.map(({ fingerprint: _fingerprint, ...item }) => ({ ...item, source: relative(root, item.source), destination: relative(root, item.destination) })), entries: plan.entries.map(({ fingerprint: _fingerprint, ...entry }) => entry) };
  }
  async apply(token: string) {
    const plan = (await this.store.get(owner, token))?.doc as Plan | undefined;
    if (!plan || Date.parse(plan.createdAt) < Date.now() - 24 * 60 * 60_000) throw new Error("Preview expired. Create a new preview.");
    if (plan.items.some(item => item.error)) throw new Error("Resolve preview errors before applying changes.");
    return this.scheduler.dispatch(`core.library.${plan.libraryId}::${plan.kind === "rename" ? "rename" : "recycle-cleanup"}`, null, { planToken: token });
  }
  async run(libraryId: string, kind: "rename" | "recycle", runId: string, token?: string): Promise<JobResult> {
    return this.library.exclusive(libraryId, async (): Promise<JobResult> => {
      const lib = await this.library.get(libraryId);
      if (!lib.enabled) return { state: "skipped", outcome: "Library is disabled." };
      const root = await realpath(lib.rootPath);
      const plan = token ? (await this.store.get(owner, token))?.doc as Plan | undefined : undefined;
      if (token && (!plan || plan.libraryId !== libraryId || plan.kind !== kind || plan.root !== root)) throw new Error("Preview no longer matches this library.");
      const provider = await this.importer();
      if (kind === "recycle") {
        const days = (await new QualitySettings(this.db).read()).recycleBinDays;
        if (!days) return { state: "skipped", outcome: "Recycle-bin cleanup is disabled by the retention policy." };
        const result = await provider.invoke("recycle-cleanup", { root, days, ...(plan ? { entries: plan.entries.filter(e => e.expired).map(({ id, fingerprint }) => ({ id, fingerprint })) } : {}) }) as { removed: number; bytes: number };
        return { outcome: `${result.removed} expired recycle-bin files removed.`, counts: { ...result } };
      }
      if (!plan) return { state: "blocked", outcome: "Create and approve a rename preview in File maintenance." };
      if (plan.items.some(i => i.error)) throw new Error("Rename preview contains errors.");
      let renamed = 0, unchanged = 0, failed = 0;
      const reasons: string[] = [];
      for (const item of plan.items) {
        if (item.source === item.destination) { unchanged++; continue; }
        try {
          const current = await this.db.selectFrom("media_catalog").selectAll().where("fileId", "=", item.fileId).executeTakeFirst();
          if (!current || current.libraryId !== libraryId || ![item.source, item.destination].includes(current.path)) throw new Error("Catalog changed since preview.");
          if (this.container.hasProviders("dev.tantalar.capability.serving")) {
            const { sessions } = await this.container.resolve("dev.tantalar.capability.serving").invoke("playback-sessions", {}) as { sessions: Array<{ fileId: string; endedAt?: unknown }> };
            if (sessions.some(s => s.fileId === item.fileId && !s.endedAt)) throw new Error("File has an active playback session.");
          }
          await provider.invoke("rename-file", { root, source: item.source, destination: item.destination, fingerprint: item.fingerprint });
          await this.db.updateTable("media_catalog").set({ path: item.destination, updatedAt: new Date().toISOString() }).where("fileId", "=", item.fileId).execute();
          await this.library.refreshCatalogEntry(item.fileId);
          await this.bus.publish({ type: "dev.tantalar.event.job.file.renamed", producer: "dev.tantalar.core.scheduler", subject: item.fileId, correlationId: runId, payload: { libraryId, fileId: item.fileId } });
          renamed++;
        } catch (error) { failed++; reasons.push(`${relative(root, item.source)}: ${safeJobError(error)}`); }
      }
      return { state: failed ? "partial" : "succeeded", outcome: `${renamed} renamed, ${unchanged} unchanged, ${failed} failed.`, counts: { renamed, unchanged, failed }, reasons };
    });
  }
}
