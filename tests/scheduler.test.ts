import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDatabase, type Db } from "@tantalar/db";
import { Kysely } from "kysely";
import { Scheduler, nextRunAt } from "../apps/server/src/scheduler.js";

let db: Kysely<Db>;
let scheduler: Scheduler;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "tantalar-sched-"));
  db = await openDatabase({ dialect: "sqlite", sqlitePath: join(dir, "test.db") });
  await migrate(db);
  scheduler = new Scheduler(db);
});

afterAll(async () => {
  await db.destroy();
});

describe("scheduler persistence and idempotency", () => {
  it("parses schedules and rejects unknown ones", async () => {
    expect(nextRunAt("every 5m")!.getTime()).toBeGreaterThan(Date.now());
    expect(nextRunAt("daily 03:00")).toBeTruthy();
    expect(nextRunAt("gibberish")).toBeNull();
    await expect(
      scheduler.declareJob("dev.tantalar.plugin.x", "job", "nonsense", () => undefined),
    ).rejects.toThrow(/unparseable/);
  });

  it("declaring the same jobKey twice does not duplicate (idempotency key)", async () => {
    await scheduler.declareJob("dev.tantalar.plugin.p1", "tick", "every 1h", () => undefined);
    await scheduler.declareJob("dev.tantalar.plugin.p1", "tick", "every 2h", () => undefined);
    const rows = await db
      .selectFrom("scheduler_jobs")
      .selectAll()
      .where("plugin_id", "=", "dev.tantalar.plugin.p1")
      .execute();
    expect(rows.length).toBe(1);
    expect(rows[0]?.schedule).toBe("every 2h");
  });

  it("fires due jobs exactly once per tick and persists last-run state", async () => {
    let fires = 0;
    await scheduler.declareJob("dev.tantalar.plugin.p2", "once", "every 1h", () => {
      fires++;
    });
    // Force due.
    await db
      .updateTable("scheduler_jobs")
      .set({ next_run_at: new Date(Date.now() - 1000).toISOString() } as never)
      .where("job_key", "=", "dev.tantalar.plugin.p2::once")
      .execute();

    await scheduler.tick();
    expect(fires).toBe(1);

    const [row] = await db
      .selectFrom("scheduler_jobs")
      .selectAll()
      .where("job_key", "=", "dev.tantalar.plugin.p2::once")
      .execute();
    expect(row?.lastRunAt).toBeTruthy();
    expect(row?.lockedAt).toBeNull(); // lock released
    expect(new Date(row?.nextRunAt ?? 0).getTime()).toBeGreaterThan(Date.now()); // not immediately re-due

    // A second tick must not double-fire.
    await scheduler.tick();
    expect(fires).toBe(1);
  });

  it("removing a plugin's jobs clears persisted state (unmount rollback)", async () => {
    await scheduler.declareJob("dev.tantalar.plugin.p3", "j", "every 1m", () => undefined);
    await scheduler.removeJobsFor("dev.tantalar.plugin.p3");
    const rows = await db
      .selectFrom("scheduler_jobs")
      .selectAll()
      .where("plugin_id", "=", "dev.tantalar.plugin.p3")
      .execute();
    expect(rows.length).toBe(0);
  });
});
