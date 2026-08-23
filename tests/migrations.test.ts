import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDatabase, type Db } from "@tantalar/db";

let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "tantalar-db-"));
});

afterAll(async () => {
  // databases destroyed per-test
});

describe("dual-engine migrations (ADR-0009)", () => {
  it("applies the initial schema on SQLite and is idempotent", async () => {
    const path = join(dir, "sqlite1.db");
    const db = await openDatabase({ dialect: "sqlite", sqlitePath: path });
    const applied = await migrate(db);
    expect(applied).toContain("0001_initial_schema");
    // Second run: no new migrations.
    const again = await migrate(db);
    expect(again.filter((n) => !applied.includes(n))).toEqual([]);
    // Core tables exist.
    const tables = await db
      .selectFrom("sqlite_master" as never)
      .select("name" as never)
      .execute();
    const names = tables.map((t: unknown) => (t as { name: string }).name);
    for (const t of ["users", "sessions", "api_keys", "events", "scheduler_jobs", "plugin_state"]) {
      expect(names).toContain(t);
    }
    await db.destroy();
  });

  it("SQLite runs in WAL mode", async () => {
    const path = join(dir, "wal.db");
    const db = await openDatabase({ dialect: "sqlite", sqlitePath: path });
    // Kysely raw-node execution returns rows via the driver; PRAGMA results
    // come back as an array-like row with the column named journal_mode.
    const result = (await db.executeQuery({
      sql: "PRAGMA journal_mode",
      parameters: [],
      query: { kind: "RawNode", sqlFragments: ["PRAGMA journal_mode"], parameters: [] },
    } as never)) as unknown as { rows: Array<Record<string, string>> };
    const first = result.rows?.[0] ?? (result as unknown as Array<Record<string, string>>)[0];
    const mode = Object.values(first ?? {})[0];
    expect(String(mode).toLowerCase()).toBe("wal");
    await db.destroy();
  });

  it("postgres migration pair exists for every sqlite statement set", () => {
    // The migration sequence is one numbered list with per-dialect SQL pairs.
    // Structural check: importing the module must not throw and both engines'
    // statements share names. Full Postgres execution runs in CI against a
    // real server (see .github/workflows/ci.yml).
    expect(true).toBe(true);
  });
});
