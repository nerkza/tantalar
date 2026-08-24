/**
 * Wave 2 concurrency on PostgreSQL (review follow-up). The bootstrap_lock
 * singleton-row update must serialize concurrent createInitialAdmin calls
 * even under READ COMMITTED with *different* usernames, where per-username
 * uniqueness alone would allow two administrators. Also covers concurrent
 * first reads of onboarding state (no primary-key exception).
 *
 * Skipped unless Postgres is available: TEST_POSTGRES_URL set directly, or
 * TANTALAR_CI_POSTGRES=1 (CI, see .github/workflows/ci.yml).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDatabase, type Db } from "@tantalar/db";
import { Kysely } from "kysely";
import { AuthService } from "../apps/server/src/auth.js";
import { OnboardingService } from "../apps/server/src/onboarding.js";

const pgUrl =
  process.env["TEST_POSTGRES_URL"] ??
  (process.env["TANTALAR_CI_POSTGRES"] === "1"
    ? "postgres://postgres:postgres@localhost:5432/tantalar_ci"
    : undefined);

let db: Kysely<Db> | null = null;

beforeAll(async () => {
  if (!pgUrl) return;
  db = await openDatabase({ dialect: "postgres", postgresUrl: pgUrl });
  await migrate(db);
  // Reset state left by any previous run against this database so the
  // bootstrap race always starts from zero users.
  await db.deleteFrom("users").execute();
  await db.deleteFrom("onboarding_state").execute();
});

afterAll(async () => {
  if (db) await db.destroy();
});

describe("Wave 2 concurrency on PostgreSQL", () => {
  // Gate on pgUrl, not db: it.skipIf is evaluated during suite definition,
  // before beforeAll assigns db.
  it.skipIf(!pgUrl)(
    "concurrent different usernames cannot create two bootstrap administrators",
    async () => {
      if (!db) return;
      const auth = new AuthService(db);
      const attempts = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          auth.createInitialAdmin(`racer-${i}`, "password-racer-1"),
        ),
      );
      const created = attempts.filter((a) => a.ok);
      expect(created).toHaveLength(1);
      const users = await db.selectFrom("users").selectAll().execute();
      expect(users).toHaveLength(1);
      expect(users[0]?.role).toBe("admin");
      for (const a of attempts.filter((x) => !x.ok)) {
        expect(a.reason).toBe("closed");
      }
    },
  );

  it.skipIf(!pgUrl)("bootstrap fails closed after the admin exists", async () => {
    if (!db) return;
    const auth = new AuthService(db);
    const res = await auth.createInitialAdmin("latecomer", "password-late-01");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("closed");
  });

  it.skipIf(!pgUrl)("concurrent first onboarding reads never throw a primary-key error", async () => {
    if (!db) return;
    const onboarding = new OnboardingService(db);
    const states = await Promise.all(
      Array.from({ length: 8 }, () => onboarding.getState()),
    );
    for (const state of states) {
      expect(state.complete).toBe(false);
      expect(Object.keys(state.steps)).toHaveLength(8);
    }
    // A later read still works and sees one durable row.
    const final = await onboarding.getState();
    expect(final.steps["administrator"].status).toBe("pending");
  });
});
