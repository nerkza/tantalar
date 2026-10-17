import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDatabase, type Db } from "@tantalar/db";
import { Kysely } from "kysely";
import { AuthService } from "../apps/server/src/auth.js";

let db: Kysely<Db>;
let auth: AuthService;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "tantalar-auth-"));
  db = await openDatabase({ dialect: "sqlite", sqlitePath: join(dir, "test.db") });
  await migrate(db);
  auth = new AuthService(db, 3600);
});

afterAll(async () => {
  await db.destroy();
});

describe("auth boundaries (ADR-0011)", () => {
  it("Argon2id hashes verify and reject wrong passwords", async () => {
    await auth.createUser("admin", "correct-horse-battery", "admin");
    const ok = await auth.verifyPassword("admin", "correct-horse-battery");
    expect(ok?.role).toBe("admin");
    expect(await auth.verifyPassword("admin", "wrong")).toBeNull();
    const [row] = await db.selectFrom("users").selectAll().execute();
    // Stored hash is Argon2id, not the plaintext.
    expect(row?.passwordHash.startsWith("$argon2id$")).toBe(true);
  });

  it("rejects short passwords", async () => {
    await expect(auth.createUser("shorty", "1234567", "viewer")).rejects.toThrow(/8 characters/);
  });

  it("sessions are opaque; only the hash is stored server-side", async () => {
    const id = await auth.createUser("alice", "password-abc-123", "viewer");
    const { token } = await auth.createSession(id);
    const [row] = await db
      .selectFrom("sessions")
      .selectAll()
      .where("userId", "=", id)
      .execute();
    expect(row?.tokenHash).not.toBe(token);
    const session = await auth.getSession(token);
    expect(session?.role).toBe("viewer");
  });

  it("destroyed sessions stop resolving", async () => {
    const id = await auth.createUser("bob", "password-def-456", "viewer");
    const { token } = await auth.createSession(id);
    await auth.destroySession(token);
    expect(await auth.getSession(token)).toBeNull();
  });

  it("expired sessions are rejected", async () => {
    const short = new AuthService(db, -1); // already expired
    const id = await auth.createUser("carol", "password-ghi-789", "viewer");
    const { token } = await short.createSession(id);
    expect(await auth.getSession(token)).toBeNull();
  });

  it("API keys are returned once and stored hashed with scopes enforced", async () => {
    const { key } = await auth.createApiKey("machine", ["events.read"]);
    const [row] = await db.selectFrom("api_keys").selectAll().execute();
    expect(row?.keyHash).not.toBe(key);
    expect(key.startsWith("tantalar_")).toBe(true);

    expect(await auth.verifyApiKey(key, "events.read")).toBeTruthy();
    expect(await auth.verifyApiKey(key, "admin.write")).toBeNull(); // scope denied
    expect(await auth.verifyApiKey("not-a-tantalar-key")).toBeNull();
  });

  it("revoked API keys stop working", async () => {
    const { id, key } = await auth.createApiKey("revoked", ["events.read"]);
    await auth.revokeApiKey(id);
    expect(await auth.verifyApiKey(key)).toBeNull();
  });

  it("CSRF double-submit requires matching cookie and header tokens", () => {
    expect(AuthService.verifyCsrf("tok", "tok")).toBe(true);
    expect(AuthService.verifyCsrf("tok", "other")).toBe(false);
    expect(AuthService.verifyCsrf(undefined, "tok")).toBe(false);
    expect(AuthService.verifyCsrf("tok", undefined)).toBe(false);
  });
});
