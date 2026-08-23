import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDatabase, type Db } from "@tantalar/db";
import { Kysely } from "kysely";
import { EventBus } from "../apps/server/src/events.js";
import { uuidv7 } from "@tantalar/contracts";

let db: Kysely<Db>;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "tantalar-events-"));
  db = await openDatabase({ dialect: "sqlite", sqlitePath: join(dir, "test.db") });
  await migrate(db);
});

afterAll(async () => {
  await db.destroy();
});

describe("event bus + append-only log (ADR-0007)", () => {
  it("append precedes fan-out and the envelope round-trips", async () => {
    const bus = new EventBus(db);
    const seen: string[] = [];
    const unsub = bus.subscribe("dev.tantalar.event.", async (env) => {
      // By fan-out time, the event must already be readable from the log.
      const rows = await bus.read({ correlationId: env.correlationId });
      if (rows.some((r) => r.eventId === env.eventId)) seen.push(env.eventId);
    });
    const env = await bus.publish({
      type: "dev.tantalar.event.test.appended",
      producer: "core",
      payload: { n: 1 },
      correlationId: "corr-1",
    });
    unsub();
    expect(seen).toEqual([env.eventId]);
  });

  it("duplicate eventId appends are idempotent", async () => {
    const bus = new EventBus(db);
    const before = await bus.count();
    const id = uuidv7();
    await bus.publish({ type: "dev.tantalar.event.test.dup", producer: "core", eventId: id });
    await bus.publish({ type: "dev.tantalar.event.test.dup", producer: "core", eventId: id });
    expect(await bus.count()).toBe(before + 1);
  });

  it("replay filters by type prefix, subject, correlation, and cursor", async () => {
    const bus = new EventBus(db);
    const e1 = await bus.publish({
      type: "dev.tantalar.event.replay.a",
      producer: "core",
      subject: "s1",
      correlationId: "rc1",
      payload: {},
    });
    await bus.publish({
      type: "dev.tantalar.event.other.b",
      producer: "core",
      subject: "s2",
      payload: {},
    });
    await bus.publish({
      type: "dev.tantalar.event.replay.c",
      producer: "core",
      subject: "s1",
      correlationId: "rc1",
      causationId: e1.eventId,
      payload: {},
    });

    const byType = await bus.read({ typePrefix: "dev.tantalar.event.replay." });
    expect(byType.length).toBe(2);
    const byCorrelation = await bus.read({ correlationId: "rc1" });
    expect(byCorrelation.length).toBe(2);
    expect(byCorrelation[1]?.causationId).toBe(e1.eventId); // chain preserved
    const bySubject = await bus.read({ subject: "s1" });
    expect(bySubject.length).toBe(2);
    const byCursor = await bus.read({ afterEventId: e1.eventId, correlationId: "rc1" });
    expect(byCursor.length).toBe(1);
  });

  it("a failing subscriber does not block the producer", async () => {
    const bus = new EventBus(db);
    bus.subscribe("dev.tantalar.event.boom.", () => {
      throw new Error("subscriber exploded");
    });
    const env = await bus.publish({
      type: "dev.tantalar.event.boom.x",
      producer: "core",
    });
    expect(env.eventId).toBeTruthy();
  });

  it("no update/delete path exists on events (immutability)", async () => {
    const bus = new EventBus(db);
    await bus.publish({ type: "dev.tantalar.event.imm.x", producer: "core" });
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(bus));
    expect(methods.filter((m) => /update|delete/i.test(m))).toEqual([]);
  });
});
