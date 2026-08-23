/**
 * Scheduler: cron-like dispatch with persisted, idempotent job state
 * (architecture §4). Restart must not double-fire: jobKey is unique.
 */
import { uuidv7 } from "@tantalar/contracts";
import type { Kysely } from "kysely";
import type { Db } from "@tantalar/db";

export interface JobHandler {
  (): Promise<void> | void;
}

/** Minimal cron-ish schedule: "every <n><s|m|h>" or "daily HH:MM" (UTC). */
export function nextRunAt(schedule: string, from: Date = new Date()): Date | null {
  const every = /^every (\d+)([smh])$/.exec(schedule);
  if (every) {
    const n = Number(every[1]);
    const unitMs = { s: 1000, m: 60_000, h: 3_600_000 }[every[2] as "s" | "m" | "h"];
    return new Date(from.getTime() + n * unitMs);
  }
  const daily = /^daily (\d{2}):(\d{2})$/.exec(schedule);
  if (daily) {
    const next = new Date(from);
    next.setUTCHours(Number(daily[1]), Number(daily[2]), 0, 0);
    if (next <= from) next.setUTCDate(next.getUTCDate() + 1);
    return next;
  }
  return null;
}

export class Scheduler {
  readonly #db: Kysely<Db>;
  readonly #handlers = new Map<string, JobHandler>();
  #timer: NodeJS.Timeout | null = null;
  readonly #tickMs: number;

  constructor(db: Kysely<Db>, tickMs = 1000) {
    this.#db = db;
    this.#tickMs = tickMs;
  }

  /**
   * Declare a job. Idempotent on (pluginId + jobKey): redeclaring the same
   * key updates the schedule but never duplicates the row.
   */
  async declareJob(pluginId: string, jobKey: string, schedule: string, handler: JobHandler): Promise<string> {
    if (!nextRunAt(schedule)) throw new Error(`unparseable schedule: ${schedule}`);
    const composite = `${pluginId}::${jobKey}`;
    const [existing] = await this.#db
      .selectFrom("scheduler_jobs")
      .selectAll()
      .where("jobKey", "=", composite)
      .execute();
    const now = new Date();
    if (existing) {
      await this.#db
        .updateTable("scheduler_jobs")
        .set({ schedule, nextRunAt: nextRunAt(schedule, now)?.toISOString() ?? null })
        .where("id", "=", existing.id)
        .execute();
    } else {
      await this.#db
        .insertInto("scheduler_jobs")
        .values({
          id: uuidv7(),
          pluginId,
          jobKey: composite,
          schedule,
          lastRunAt: null,
          nextRunAt: nextRunAt(schedule, now)?.toISOString() ?? null,
          lockedAt: null,
        })
        .onConflict((oc) => oc.column("jobKey").doNothing())
        .execute();
    }
    this.#handlers.set(composite, handler);
    return composite;
  }

  async removeJobsFor(pluginId: string): Promise<void> {
    await this.#db.deleteFrom("scheduler_jobs").where("pluginId", "=", pluginId).execute();
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.tick(), this.#tickMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** Single dispatch pass; lock-claim prevents concurrent double-fire. */
  async tick(onFire?: (pluginId: string, jobKey: string) => Promise<void>): Promise<number> {
    const now = new Date().toISOString();
    const due = await this.#db
      .selectFrom("scheduler_jobs")
      .selectAll()
      .where("nextRunAt", "<=", now)
      .where("lockedAt", "is", null)
      .execute();
    let fired = 0;
    for (const job of due) {
      // Atomic claim: only one runner may take the job.
      const claimed = await this.#db
        .updateTable("scheduler_jobs")
        .set({ lockedAt: now })
        .where("id", "=", job.id)
        .where("lockedAt", "is", null)
        .returning("id")
        .executeTakeFirst();
      if (!claimed && !(await this.claimedSqlite(job.id, now))) continue;

      const handler = this.#handlers.get(job.jobKey);
      try {
        if (handler) await handler();
        fired++;
        await onFire?.(job.pluginId, job.jobKey);
      } finally {
        const next = nextRunAt(job.schedule);
        await this.#db
          .updateTable("scheduler_jobs")
          .set({ lockedAt: null, lastRunAt: now, nextRunAt: next ? next.toISOString() : null })
          .where("id", "=", job.id)
          .execute();
      }
    }
    return fired;
  }

  async #claimedSqlite(id: string, now: string): Promise<boolean> {
    const res = await this.#db
      .updateTable("scheduler_jobs")
      .set({ lockedAt: now })
      .where("id", "=", id)
      .where("lockedAt", "is", null)
      .execute();
    return res.length > 0;
  }

  async claimedSqlite(id: string, now: string): Promise<boolean> {
    return this.#claimedSqlite(id, now);
  }
}
