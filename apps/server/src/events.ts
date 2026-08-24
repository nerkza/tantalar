/**
 * Append-only event log + typed event bus (ADR-0007).
 * Append precedes fan-out. No update/delete path exists.
 */
import { randomUUID } from "node:crypto";
import { validateEnvelope, uuidv7, type EventEnvelope } from "@tantalar/contracts";
import { Kysely, sql } from "kysely";
import type { Db, EventsTable } from "@tantalar/db";

export interface PublishInput {
  type: string;
  producer: string;
  payload?: Record<string, unknown>;
  subject?: string;
  correlationId?: string;
  causationId?: string;
  metadata?: Record<string, unknown>;
  eventId?: string; // used by replay-driven re-appends in tests only
}

type Subscriber = (envelope: EventEnvelope) => void | Promise<void>;

export class EventBus {
  readonly #db: Kysely<Db>;
  readonly #subscribers = new Set<{ prefix: string; fn: Subscriber }>();

  constructor(db: Kysely<Db>) {
    this.#db = db;
  }

  /** Append to the log first; then fan out to subscribers. */
  async publish(input: PublishInput): Promise<EventEnvelope> {
    const envelope: EventEnvelope = {
      schemaVersion: 1,
      eventId: input.eventId ?? uuidv7(),
      type: input.type,
      occurredAt: new Date().toISOString(),
      producer: input.producer,
      ...(input.subject !== undefined ? { subject: input.subject } : {}),
      ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
      ...(input.causationId !== undefined ? { causationId: input.causationId } : {}),
      payload: input.payload ?? {},
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    };
    validateEnvelope(envelope);

    const row: EventsTable = {
      eventId: envelope.eventId,
      schemaVersion: envelope.schemaVersion,
      type: envelope.type,
      occurredAt: envelope.occurredAt,
      producer: envelope.producer,
      subject: envelope.subject ?? null,
      correlationId: envelope.correlationId ?? null,
      causationId: envelope.causationId ?? null,
      payload: JSON.stringify(envelope.payload),
      metadata: envelope.metadata ? JSON.stringify(envelope.metadata) : null,
    };
    // Idempotency: duplicate eventId is a no-op append, not an error.
    await this.#db
      .insertInto("events")
      .values(row)
      .onConflict((oc) => oc.column("eventId").doNothing())
      .execute();

    await this.fanout(envelope);
    return envelope;
  }

  async fanout(envelope: EventEnvelope): Promise<void> {
    for (const sub of [...this.#subscribers]) {
      if (!envelope.type.startsWith(sub.prefix)) continue;
      try {
        await sub.fn(envelope);
      } catch {
        // A slow/failing subscriber must not block the producer.
      }
    }
  }

  subscribe(prefix: string, fn: Subscriber): () => void {
    const entry = { prefix, fn };
    this.#subscribers.add(entry);
    return () => this.#subscribers.delete(entry);
  }

  /** Replay API: by time range, type prefix, subject, or correlationId. */
  async read(filter: {
    from?: string;
    to?: string;
    typePrefix?: string;
    subject?: string;
    correlationId?: string;
    limit?: number;
    afterEventId?: string;
  }): Promise<EventEnvelope[]> {
    let q = this.#db
      .selectFrom("events")
      .selectAll()
      // Insertion order is the authoritative tiebreaker: UUIDv7 random bits
      // do not preserve append order within one occurredAt millisecond, so
      // an eventId sort can invert a causal chain. SQLite rowid is strictly
      // monotonic per insert and stable under concurrent writers.
      .orderBy("occurredAt asc")
      .orderBy(sql`rowid asc`);
    if (filter.from) q = q.where("occurredAt", ">=", filter.from);
    if (filter.to) q = q.where("occurredAt", "<=", filter.to);
    if (filter.typePrefix) q = q.where("type", "like", `${filter.typePrefix}%`);
    if (filter.subject) q = q.where("subject", "=", filter.subject);
    if (filter.correlationId) q = q.where("correlationId", "=", filter.correlationId);
    if (filter.afterEventId) {
      const [anchor] = await this.#db
        .selectFrom("events")
        .select(["occurredAt", "eventId"])
        .where("eventId", "=", filter.afterEventId)
        .execute();
      if (!anchor) throw new Error(`unknown afterEventId ${filter.afterEventId}`);
      // Cursor pagination uses the identical insertion-order tiebreaker.
      const anchorRowid = await this.#db
        .selectFrom("events")
        .select(sql<number>`rowid`.as("rowid"))
        .where("eventId", "=", filter.afterEventId)
        .executeTakeFirstOrThrow();
      q = q.where(sql`rowid`, ">", anchorRowid.rowid);
    }
    const rows = await q.limit(filter.limit ?? 1000).execute();
    return rows.map(rowToEnvelope);
  }

  async count(): Promise<number> {
    const [row] = await this.#db
      .selectFrom("events")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .execute();
    return Number(row?.n ?? 0);
  }
}

export function rowToEnvelope(row: EventsTable): EventEnvelope {
  const env: EventEnvelope = {
    schemaVersion: row.schemaVersion as 1,
    eventId: row.eventId,
    type: row.type,
    occurredAt: row.occurredAt,
    producer: row.producer,
    ...(row.subject !== null ? { subject: row.subject } : {}),
    ...(row.correlationId !== null ? { correlationId: row.correlationId } : {}),
    ...(row.causationId !== null ? { causationId: row.causationId } : {}),
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    ...(row.metadata ? { metadata: JSON.parse(row.metadata) as Record<string, unknown> } : {}),
  };
  return validateEnvelope(env);
}

export function newCorrelationId(): string {
  return randomUUID();
}
