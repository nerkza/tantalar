/** Persistent jobs. One kernel owns execution; database claims prevent duplicate dispatch. */
import { uuidv7 } from "@tantalar/contracts";
import { sql, type Kysely } from "kysely";
import type { Db } from "@tantalar/db";
import type { EventBus } from "./events.js";

export interface JobResult {
  state?: "succeeded" | "skipped" | "blocked" | "partial";
  outcome: string;
  counts?: Record<string, number>;
  reasons?: string[];
}
export interface JobHandler { (context: { runId: string; input?: Record<string, unknown> }): Promise<JobResult | void> | JobResult | void }
export interface JobDefinition {
  name?: string;
  scope?: string;
  protected?: boolean;
  enabled?: boolean;
  resource?: string;
  successRetention?: number;
  manualOnly?: boolean;
}
export const safeJobError = (error: unknown): string => String((error as Error)?.message ?? error)
  .replace(/https?:\/\/[^\s]+/gi, "[provider URL]")
  .replace(/((?:password|token|secret|api[-_]?key|authorization)\s*[=:]\s*)[^\s,;]+/gi, "$1[redacted]")
  .slice(0, 500);
const fail = (message: string, statusCode = 409): never => { throw Object.assign(new Error(message), { statusCode }); };

/** Daily schedules are fixed UTC, including through daylight-saving changes. */
export function nextRunAt(schedule: string, from = new Date()): Date | null {
  const every = /^every (\d+)([smh])$/.exec(schedule);
  if (every) {
    const n = Number(every[1]);
    const ms = n * ({ s: 1000, m: 60_000, h: 3_600_000 }[every[2] as "s" | "m" | "h"]);
    if (!Number.isSafeInteger(n) || n < 1 || ms > 365 * 86_400_000) return null;
    const next = new Date(from.getTime() + ms);
    return Number.isNaN(next.getTime()) ? null : next;
  }
  const daily = /^daily (\d{2}):(\d{2})$/.exec(schedule);
  if (!daily || Number(daily[1]) > 23 || Number(daily[2]) > 59) return null;
  const next = new Date(from);
  next.setUTCHours(Number(daily[1]), Number(daily[2]), 0, 0);
  if (next <= from) next.setUTCDate(next.getUTCDate() + 1);
  return Number.isNaN(next.getTime()) ? null : next;
}

export class Scheduler {
  readonly #handlers = new Map<string, JobHandler>();
  readonly #definitions = new Map<string, JobDefinition>();
  readonly #active = new Map<string, Promise<unknown>>();
  readonly #resources = new Set<string>();
  #timer: NodeJS.Timeout | null = null;
  #onError: (error: unknown) => void = error => process.stderr.write(`scheduler: ${safeJobError(error)}\n`);
  constructor(private readonly db: Kysely<Db>, private readonly tickMs = 1000, private readonly bus?: EventBus) {}

  async declareJob(pluginId: string, jobKey: string, schedule: string, handler: JobHandler, definition: JobDefinition = {}): Promise<string> {
    if (!nextRunAt(schedule)) throw new Error(`unparseable schedule: ${schedule}`);
    const composite = `${pluginId}::${jobKey}`;
    const existing = await this.db.selectFrom("scheduler_jobs").selectAll().where("jobKey", "=", composite).executeTakeFirst();
    if (existing) {
      const changedDefault = existing.defaultSchedule !== schedule;
      const overridden = existing.schedule !== (existing.defaultSchedule ?? schedule);
      await this.db.updateTable("scheduler_jobs").set({
        defaultSchedule: schedule,
        ...(changedDefault && !overridden ? { schedule, nextRunAt: existing.enabled ? nextRunAt(schedule)!.toISOString() : null } : {}),
      }).where("id", "=", existing.id).execute();
    } else {
      await this.db.insertInto("scheduler_jobs").values({
        id: uuidv7(), pluginId, jobKey: composite, schedule, defaultSchedule: schedule,
        enabled: definition.enabled === false ? 0 : 1, lastRunAt: null,
        nextRunAt: definition.enabled === false ? null : nextRunAt(schedule)!.toISOString(), lockedAt: null,
      }).onConflict(oc => oc.column("jobKey").doNothing()).execute();
    }
    this.#handlers.set(composite, handler);
    this.#definitions.set(composite, definition);
    return composite;
  }

  async removeJobsFor(pluginId: string): Promise<void> {
    const jobs = await this.db.selectFrom("scheduler_jobs").select("jobKey").where("pluginId", "=", pluginId).execute();
    for (const job of jobs) { this.#handlers.delete(job.jobKey); this.#definitions.delete(job.jobKey); }
    await this.db.deleteFrom("scheduler_jobs").where("pluginId", "=", pluginId).execute();
  }

  async listJobs() {
    const jobs = await this.db.selectFrom("scheduler_jobs").selectAll().orderBy("jobKey").execute();
    return Promise.all(jobs.map(async job => ({
      ...job, name: this.#definitions.get(job.jobKey)?.name ?? job.jobKey,
      scope: this.#definitions.get(job.jobKey)?.scope ?? "System",
      protected: this.#definitions.get(job.jobKey)?.protected ?? false,
      manualOnly: this.#definitions.get(job.jobKey)?.manualOnly ?? false,
      registered: this.#handlers.has(job.jobKey),
      latestRun: await this.db.selectFrom("scheduler_runs").selectAll().where("jobKey", "=", job.jobKey)
        .orderBy("startedAt", "desc").orderBy("id", "desc").limit(1).executeTakeFirst() ?? null,
    })));
  }

  async updateJob(jobKey: string, input: { schedule?: string; enabled?: boolean; restoreDefault?: boolean }) {
    const row = await this.#job(jobKey);
    if (this.#definitions.get(jobKey)?.protected) fail("This system job has a protected schedule.");
    if (this.#definitions.get(jobKey)?.manualOnly) fail("This operation requires an approved preview and cannot be scheduled.");
    const schedule = input.restoreDefault ? row.defaultSchedule ?? row.schedule : input.schedule ?? row.schedule;
    const next = nextRunAt(schedule);
    if (!next) fail("Use a positive interval of at most 365 days or daily HH:MM in UTC.", 400);
    const enabled = input.enabled === undefined ? row.enabled : Number(input.enabled);
    await this.db.updateTable("scheduler_jobs").set({ schedule, enabled, nextRunAt: enabled ? next!.toISOString() : null })
      .where("id", "=", row.id).execute();
    await this.#event("updated", jobKey, uuidv7(), { schedule, enabled: Boolean(enabled) });
    return this.#job(jobKey);
  }

  async listRuns(jobKey?: string, page = 1, pageSize = 25, query: Record<string, unknown> = {}) {
    const size = Number.isSafeInteger(pageSize) ? Math.min(100, Math.max(1, pageSize)) : 25;
    const current = Number.isSafeInteger(page) ? Math.min(1_000_000, Math.max(1, page)) : 1;
    let q = this.db.selectFrom("scheduler_runs");
    if (jobKey) q = q.where("jobKey", "=", jobKey);
    if (typeof query.filter_state === "string") q = q.where("state", "=", query.filter_state as never);
    if (typeof query.filter_trigger === "string") q = q.where("trigger", "=", query.filter_trigger);
    if (typeof query.search === "string" && query.search.trim()) {
      const search = query.search.trim().toLowerCase().slice(0, 200);
      const matchingKeys = [...this.#definitions].filter(([key, d]) => `${key} ${d.name} ${d.scope}`.toLowerCase().includes(search)).map(([key]) => key);
      q = q.where(eb => eb.or([
        eb(sql`lower(job_key)`, "like", `%${search}%`), eb(sql`lower(outcome)`, "like", `%${search}%`),
        eb(sql`lower(error)`, "like", `%${search}%`), ...(matchingKeys.length ? [eb("jobKey", "in", matchingKeys)] : []),
      ]));
    }
    const sort = ["startedAt", "durationMs", "state", "jobKey", "trigger", "outcome"].includes(String(query.sort)) ? String(query.sort) : "startedAt";
    const direction = query.sort ? query.desc === "true" ? "desc" : "asc" : "desc";
    const count = await q.select(eb => eb.fn.countAll<number>().as("count")).executeTakeFirstOrThrow();
    const runs = await q.selectAll().orderBy(sort as "startedAt", direction).orderBy("id", "desc")
      .limit(size).offset((current - 1) * size).execute();
    return { runs: runs.map(run => ({ ...run, traceAvailable: !(this.#definitions.get(run.jobKey)?.successRetention && run.trigger === "scheduled" && ["running", "succeeded"].includes(run.state)), name: this.#definitions.get(run.jobKey)?.name ?? run.jobKey, scope: this.#definitions.get(run.jobKey)?.scope ?? "System" })), page: current, pageSize: size, total: Number(count.count) };
  }

  async #job(key: string) {
    const row = await this.db.selectFrom("scheduler_jobs").selectAll().where("jobKey", "=", key).executeTakeFirst();
    if (!row) return fail("Job not found.", 404);
    if (!this.#handlers.has(key)) return fail("The job provider is not available.");
    return row;
  }

  /** API dispatch returns after the durable running record exists. */
  async dispatch(jobKey: string, retryOf: string | null = null, input?: Record<string, unknown>): Promise<string> {
    const job = await this.#job(jobKey);
    const now = new Date().toISOString();
    if (!await this.#claim(job.id, now)) return fail("Job is already running.");
    const runId = uuidv7();
    await this.#begin(job, runId, now, retryOf ? "retry" : "manual", retryOf, input);
    const work = this.#run(job, runId, now).catch(this.#onError).finally(() => this.#active.delete(runId));
    this.#active.set(runId, work);
    return runId;
  }

  async runNow(jobKey: string): Promise<string> {
    const job = await this.#job(jobKey);
    const now = new Date().toISOString();
    if (!await this.#claim(job.id, now)) return fail("Job is already running.");
    const runId = uuidv7();
    await this.#begin(job, runId, now, "manual", null);
    return this.#run(job, runId, now);
  }

  async retryRun(runId: string): Promise<string> {
    const run = await this.db.selectFrom("scheduler_runs").selectAll().where("id", "=", runId).executeTakeFirst();
    if (!run) return fail("Run not found.", 404);
    if (!["failed", "partial", "blocked", "interrupted"].includes(run.state)) return fail("Only failed, partial, blocked or interrupted runs can be retried.");
    return this.dispatch(run.jobKey, runId, run.details ? JSON.parse(run.details).input : undefined);
  }

  /** Exclusive kernel startup only. Never expire a live worker's lock by age. */
  async recoverInterrupted(): Promise<void> {
    if (this.#timer || this.#active.size) fail("Cannot recover jobs while the scheduler is running.");
    await this.db.transaction().execute(async tx => {
      await tx.updateTable("scheduler_runs").set({ state: "interrupted", finishedAt: new Date().toISOString(), error: "Server stopped before the run completed. Review its outcome before retrying." }).where("state", "=", "running").execute();
      await tx.updateTable("scheduler_jobs").set({ lockedAt: null }).execute();
    });
  }

  async pruneHistory(days = 30, apply = true): Promise<number> {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const q = this.db.selectFrom("scheduler_runs").where("state", "!=", "running").where("startedAt", "<", cutoff);
    if (!apply) return Number((await q.select(eb => eb.fn.countAll<number>().as("count")).executeTakeFirstOrThrow()).count);
    const ids = await q.select("id").orderBy("startedAt").limit(1000).execute();
    if (!ids.length) return 0;
    const result = await this.db.deleteFrom("scheduler_runs").where("id", "in", ids.map(r => r.id)).where("state", "!=", "running").executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  start(onError = this.#onError): void {
    if (this.#timer) return;
    this.#onError = onError;
    this.#timer = setInterval(() => {
      const id = uuidv7();
      const work = this.tick().catch(onError).finally(() => this.#active.delete(id));
      this.#active.set(id, work);
    }, this.tickMs);
    this.#timer.unref?.();
  }
  stop(): void { if (this.#timer) clearInterval(this.#timer); this.#timer = null; }
  async drain(): Promise<void> { await Promise.allSettled([...this.#active.values()]); }

  async tick(onFire?: (pluginId: string, jobKey: string) => Promise<void>): Promise<number> {
    const now = new Date().toISOString();
    const due = await this.db.selectFrom("scheduler_jobs").selectAll().where("nextRunAt", "<=", now).where("enabled", "=", 1).where("lockedAt", "is", null).execute();
    let fired = 0;
    const errors: unknown[] = [];
    for (const job of due) {
      if (!this.#handlers.has(job.jobKey) || this.#definitions.get(job.jobKey)?.manualOnly || !await this.#claim(job.id, now, true)) continue;
      const runId = uuidv7();
      try {
        await this.#begin(job, runId, now, "scheduled", null);
        await this.#run(job, runId, now, onFire);
      } catch (error) { errors.push(error); }
      fired++;
    }
    if (errors.length) throw errors[0];
    return fired;
  }

  async #claim(id: string, now: string, scheduled = false): Promise<boolean> {
    let q = this.db.updateTable("scheduler_jobs").set({ lockedAt: now }).where("id", "=", id).where("lockedAt", "is", null);
    if (scheduled) q = q.where("enabled", "=", 1).where("nextRunAt", "<=", now);
    return Number((await q.executeTakeFirst()).numUpdatedRows) === 1;
  }
  async claimedSqlite(id: string, now: string): Promise<boolean> { return this.#claim(id, now); }

  async #begin(job: { id: string; pluginId: string; jobKey: string }, runId: string, startedAt: string, trigger: string, retryOf: string | null, input?: Record<string, unknown>) {
    try {
      await this.db.insertInto("scheduler_runs").values({ id: runId, pluginId: job.pluginId, jobKey: job.jobKey, startedAt,
        trigger, retryOf, details: input ? JSON.stringify({ input }) : null, finishedAt: null, state: "running", outcome: null, error: null, durationMs: null }).execute();
    } catch (error) {
      await this.db.updateTable("scheduler_jobs").set({ lockedAt: null }).where("id", "=", job.id).execute();
      throw error;
    }
  }

  async #event(action: string, jobKey: string, runId: string, payload: Record<string, unknown>) {
    await this.bus?.publish({ type: `dev.tantalar.event.job.${action}`, producer: "dev.tantalar.core.scheduler", subject: jobKey, correlationId: runId, payload: { runId, ...payload } });
  }

  async #run(job: { id: string; pluginId: string; jobKey: string }, runId: string, startedAt: string, onFire?: (pluginId: string, jobKey: string) => Promise<void>): Promise<string> {
    const definition = this.#definitions.get(job.jobKey);
    const resource = definition?.resource ?? job.jobKey;
    const occupied = this.#resources.has(resource);
    if (!occupied) this.#resources.add(resource);
    try {
      const started = await this.db.selectFrom("scheduler_runs").select(["details", "trigger"]).where("id", "=", runId).executeTakeFirst();
      const input = started?.details ? JSON.parse(started.details).input as Record<string, unknown> | undefined : undefined;
      const quiet = definition?.successRetention && started?.trigger === "scheduled";
      // Service success stays in bounded history; failures still emit durable Trace events.
      if (!quiet) await this.#event("started", job.jobKey, runId, {});
      const handler = this.#handlers.get(job.jobKey);
      if (!handler) throw new Error("The job provider is not available.");
      const result: JobResult | void = occupied ? { state: "blocked", outcome: "Another job is using this resource. Retry after it finishes." } : await handler({ runId, ...(input ? { input } : {}) });
      await onFire?.(job.pluginId, job.jobKey);
      const state = result?.state ?? "succeeded";
      const outcome = safeJobError(result?.outcome ?? "Completed");
      const details = JSON.stringify({ ...(input ? { input } : {}), counts: result?.counts, reasons: result?.reasons?.slice(0, 100).map(safeJobError) });
      await this.db.updateTable("scheduler_runs").set({ finishedAt: new Date().toISOString(), state, outcome, details,
        durationMs: Math.max(0, Date.now() - Date.parse(startedAt)) }).where("id", "=", runId).execute();
      if (!quiet || state !== "succeeded") await this.#event("finished", job.jobKey, runId, { state, outcome });
      if (definition?.successRetention) {
        const boundary = await this.db.selectFrom("scheduler_runs").select("startedAt").where("jobKey", "=", job.jobKey)
          .where("state", "=", "succeeded").where("trigger", "=", "scheduled").orderBy("startedAt", "desc").offset(definition.successRetention).limit(1).executeTakeFirst();
        if (boundary) await this.db.deleteFrom("scheduler_runs").where("jobKey", "=", job.jobKey).where("state", "=", "succeeded").where("trigger", "=", "scheduled").where("startedAt", "<=", boundary.startedAt).execute();
      }
      return runId;
    } catch (error) {
      const message = safeJobError(error);
      await this.db.updateTable("scheduler_runs").set({ finishedAt: new Date().toISOString(), state: "failed", error: message,
        durationMs: Math.max(0, Date.now() - Date.parse(startedAt)) }).where("id", "=", runId).execute();
      await this.#event("failed", job.jobKey, runId, { error: message });
      throw error;
    } finally {
      if (!occupied) this.#resources.delete(resource);
      const current = await this.db.selectFrom("scheduler_jobs").select(["schedule", "enabled"]).where("id", "=", job.id).executeTakeFirst();
      if (current) await this.db.updateTable("scheduler_jobs").set({ lockedAt: null, lastRunAt: startedAt,
        nextRunAt: current.enabled ? nextRunAt(current.schedule)?.toISOString() ?? null : null }).where("id", "=", job.id).execute();
    }
  }
}
