/**
 * Wave 5 (TAN-011): unified durable download job store.
 *
 * Core-owned, provider-neutral persistence for every acquisition job
 * (torrent + usenet). The store enforces the transactional lifecycle:
 *  - idempotent creation per (itemKey, source) while the job is active;
 *  - progress/ETA/warning updates that never resurrect terminal jobs;
 *  - retry bookkeeping (retryCount increments, failure cleared);
 *  - removal as a FLAG — history rows are durable and never deleted;
 *  - import handoff recorded on the completed row.
 */
import type { Kysely } from "kysely";
import type { Db, DownloadJobsTable } from "./index.js";
import {
  DOWNLOAD_JOB_STATES,
  DownloadJobError,
  uuidv7,
  type DownloadJobRecord,
  type DownloadJobSource,
  type DownloadState,
} from "@tantalar/contracts";

function parseWarnings(raw: string | unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  try {
    const parsed = JSON.parse(typeof raw === "string" ? raw : "[]") as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function rowToRecord(row: DownloadJobsTable): DownloadJobRecord {
  return {
    jobId: row.jobId,
    itemKey: row.itemKey,
    title: row.title,
    source: row.source,
    providerPluginId: row.providerPluginId,
    state: row.state as DownloadState,
    progressPercent: row.progressPercent,
    sizeBytes: Number(row.sizeBytes),
    receivedBytes: Number(row.receivedBytes),
    etaAt: row.etaAt,
    warnings: parseWarnings(row.warnings),
    retryCount: row.retryCount,
    sourceRef: row.sourceRef,
    failureReason: row.failureReason,
    removed: row.removed === 1,
    priority: Number(row.priority ?? 0),
    importHandoffPath: row.importHandoffPath,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class DownloadJobStore {
  readonly #db: Kysely<Db>;
  constructor(db: Kysely<Db>) {
    this.#db = db;
  }

  async get(jobId: string): Promise<DownloadJobRecord | null> {
    if (!jobId) throw new DownloadJobError("invalid_request", "jobId required");
    const [row] = await this.#db.selectFrom("download_jobs").selectAll().where("jobId", "=", jobId).execute();
    return row ? rowToRecord(row) : null;
  }

  /** Active (non-removed) job for an itemKey+source, or null. */
  async findActive(itemKey: string, source: DownloadJobSource): Promise<DownloadJobRecord | null> {
    const [row] = await this.#db
      .selectFrom("download_jobs")
      .selectAll()
      .where("itemKey", "=", itemKey)
      .where("source", "=", source)
      .where("removed", "=", 0)
      .execute();
    return row ? rowToRecord(row) : null;
  }

  async create(input: {
    itemKey: string;
    title: string;
    source: DownloadJobSource;
    providerPluginId: string;
    sourceRef: string;
    sizeBytes?: number;
    jobId?: string;
  }): Promise<{ record: DownloadJobRecord; created: boolean }> {
    for (const [k, v] of Object.entries({
      itemKey: input.itemKey,
      title: input.title,
      sourceRef: input.sourceRef,
      providerPluginId: input.providerPluginId,
    })) {
      if (typeof v !== "string" || v.length === 0)
        throw new DownloadJobError("invalid_request", `${k} required`);
    }
    const existing = await this.findActive(input.itemKey, input.source);
    if (existing) return { record: existing, created: false };
    const now = new Date().toISOString();
    const row: DownloadJobsTable = {
      jobId: input.jobId ?? uuidv7(),
      itemKey: input.itemKey,
      title: input.title,
      source: input.source,
      providerPluginId: input.providerPluginId,
      state: "queued",
      progressPercent: 0,
      sizeBytes: Math.max(0, Math.trunc(input.sizeBytes ?? 0)),
      receivedBytes: 0,
      etaAt: null,
      warnings: "[]",
      retryCount: 0,
      sourceRef: input.sourceRef,
      failureReason: null,
      removed: 0,
      priority: 0,
      importHandoffPath: null,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await this.#db.insertInto("download_jobs").values(row).execute();
    } catch (err) {
      // Lost a race against a concurrent identical add.
      const msg = String((err as Error).message);
      if (msg.includes("UNIQUE") || (err as { code?: string }).code === "23505") {
        const winner = await this.findActive(input.itemKey, input.source);
        if (winner) return { record: winner, created: false };
      }
      throw err;
    }
    return { record: rowToRecord(row), created: true };
  }

  /** Progress update. Refuses to mutate terminal jobs (completed/failed/cancelled). */
  async updateProgress(
    jobId: string,
    patch: {
      state?: DownloadState;
      progressPercent?: number;
      sizeBytes?: number;
      receivedBytes?: number;
      etaAt?: string | null;
      warning?: string;
      /** Wave 9 (TAN-030): queue priority; higher runs first. */
      priority?: number;
  },
  ): Promise<DownloadJobRecord> {
    const current = await this.getOrThrow(jobId);
    if (!DOWNLOAD_JOB_STATES.has(current.state)) throw new DownloadJobError("invalid_request", `bad state ${current.state}`);
    if ((current.state === "completed" || current.state === "cancelled") && patch.state !== undefined && patch.state !== current.state) {
      throw new DownloadJobError("invalid_request", `job ${jobId} is ${current.state} and cannot move to ${patch.state}`);
    }
    const warnings = [...current.warnings];
    if (patch.warning !== undefined && !warnings.includes(patch.warning)) warnings.push(patch.warning);
    const updates: Partial<DownloadJobsTable> = { updatedAt: new Date().toISOString() };
    if (patch.state !== undefined) {
      if (!DOWNLOAD_JOB_STATES.has(patch.state)) throw new DownloadJobError("invalid_request", `bad state ${patch.state}`);
      updates.state = patch.state;
    }
    if (patch.progressPercent !== undefined) {
      updates.progressPercent = Math.max(0, Math.min(100, Math.round(patch.progressPercent)));
    }
    if (patch.sizeBytes !== undefined) updates.sizeBytes = Math.max(0, Math.trunc(patch.sizeBytes));
    if (patch.receivedBytes !== undefined) updates.receivedBytes = Math.max(0, Math.trunc(patch.receivedBytes));
    if (patch.etaAt !== undefined) updates.etaAt = patch.etaAt;
    if (patch.priority !== undefined) {
      if (!Number.isInteger(patch.priority)) throw new DownloadJobError("invalid_request", "priority must be an integer");
      updates.priority = patch.priority;
    }
    updates.warnings = JSON.stringify(warnings);
    await this.#db.updateTable("download_jobs").set(updates).where("jobId", "=", jobId).execute();
    const next = await this.getOrThrow(jobId);
    return next;
  }

  /** Mark failure durably; the record stays in history. */
  async markFailed(jobId: string, reason: string): Promise<DownloadJobRecord> {
    const current = await this.getOrThrow(jobId);
    if (current.state === "completed") throw new DownloadJobError("invalid_request", "completed jobs cannot fail retroactively");
    await this.#db
      .updateTable("download_jobs")
      .set({ state: "failed", failureReason: reason, updatedAt: new Date().toISOString() })
      .where("jobId", "=", jobId)
      .execute();
    return this.getOrThrow(jobId);
  }

  /** Retry a failed job: clears failure, bumps retryCount, back to queued. */
  async retry(jobId: string): Promise<DownloadJobRecord> {
    const current = await this.getOrThrow(jobId);
    if (current.removed) throw new DownloadJobError("invalid_request", "removed jobs cannot be retried");
    if (!(current.state === "failed" || current.state === "paused"))
      throw new DownloadJobError("invalid_request", `only failed or paused jobs can be retried (state=${current.state})`);
    await this.#db
      .updateTable("download_jobs")
      .set({
        state: "queued",
        failureReason: null,
        retryCount: current.retryCount + 1,
        updatedAt: new Date().toISOString(),
      })
      .where("jobId", "=", jobId)
      .execute();
    return this.getOrThrow(jobId);
  }

  /**
   * Queue removal: flag only. The row stays forever as durable history.
   */
  async remove(jobId: string): Promise<{ flagged: boolean }> {
    await this.getOrThrow(jobId);
    await this.#db
      .updateTable("download_jobs")
      .set({ removed: 1, updatedAt: new Date().toISOString() })
      .where("jobId", "=", jobId)
      .execute();
    return { flagged: true };
  }

  /** Record the import handoff on a completed job. */
  async recordImportHandoff(jobId: string, path: string): Promise<DownloadJobRecord> {
    const current = await this.getOrThrow(jobId);
    if (current.importHandoffPath) return current; // idempotent handoff
    if (current.state !== "completed") throw new DownloadJobError("invalid_request", "handoff requires a completed job");
    await this.#db
      .updateTable("download_jobs")
      .set({ importHandoffPath: path, updatedAt: new Date().toISOString() })
      .where("jobId", "=", jobId)
      .execute();
    return this.getOrThrow(jobId);
  }

  /**
   * Durable history: active queue first (queue order), then terminal and
   * removed rows newest-first. Never deletes anything.
   */
  async list(opts: { includeHistory?: boolean } = {}): Promise<DownloadJobRecord[]> {
    const rows = await this.#db.selectFrom("download_jobs").selectAll().orderBy("createdAt asc").execute();
    let records = rows.map(rowToRecord);
    if (!opts.includeHistory) records = records.filter((r) => !r.removed);
    // Active first in creation order, then history newest-first.
    const active = records.filter((r) => !r.removed);
    const history = records.filter((r) => r.removed).reverse();
    return [...active, ...history];
  }

  async getOrThrow(jobId: string): Promise<DownloadJobRecord> {
    const rec = await this.get(jobId);
    if (!rec) throw new DownloadJobError("unknown_job", `unknown download job ${jobId}`);
    return rec;
  }
}
