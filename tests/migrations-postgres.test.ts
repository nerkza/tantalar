import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase, migrate, type Db } from "@tantalar/db";
import { Kysely } from "kysely";

/**
 * Postgres boot behaviour without a server (architecture §11): boot must
 * fail loudly, never degrade silently. The full migration-on-Postgres run
 * executes in CI (TANTALAR_CI_POSTGRES=1, see .github/workflows/ci.yml) or
 * locally with TEST_POSTGRES_URL set.
 */
const pgUrl =
  process.env["TEST_POSTGRES_URL"] ??
  (process.env["TANTALAR_CI_POSTGRES"] === "1"
    ? process.env["TEST_POSTGRES_URL"] ?? "postgres://postgres:postgres@localhost:5432/tantalar_ci"
    : undefined);

let db: Kysely<Db> | null = null;

beforeAll(async () => {
  if (!pgUrl) return;
  db = await openDatabase({ dialect: "postgres", postgresUrl: pgUrl });
});

afterAll(async () => {
  if (db) await db.destroy();
});

describe("PostgreSQL migration path (ADR-0009)", () => {
  it.skipIf(!db)("applies the initial schema and is idempotent", async () => {
    if (!db) return;
    const applied = await migrate(db);
    expect(applied).toContain("0001_initial_schema");
    const again = await migrate(db);
    expect(again.filter((n) => !applied.includes(n))).toEqual([]);
    const users = await db.selectFrom("users").selectAll().limit(0).execute();
    expect(users).toEqual([]);
  });

  it("fails loudly when the Postgres server is unreachable", async () => {
    await expect(
      openDatabase({
        dialect: "postgres",
        postgresUrl: "postgres://postgres:postgres@127.0.0.1:1/none",
      }),
    ).rejects.toThrow();
  });
});
