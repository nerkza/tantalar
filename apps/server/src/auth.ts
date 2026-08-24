/**
 * Auth (ADR-0011): Argon2id hashes; opaque server-side session tokens in
 * Secure HttpOnly SameSite=Lax cookies; CSRF double-submit; scoped API keys
 * stored SHA-256-hashed.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import argon2 from "argon2";
import { uuidv7 } from "@tantalar/contracts";
import type { Kysely } from "kysely";
import type { Db } from "@tantalar/db";

export const API_KEY_PREFIX = "tantalar_";
export type Role = "admin" | "viewer";

export interface SessionInfo {
  userId: string;
  role: Role;
  csrfToken: string;
  expiresAt: string;
}

export interface ApiKeyRecord {
  id: string;
  name: string;
  scopes: string[];
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export class AuthService {
  readonly #db: Kysely<Db>;
  readonly #sessionTtlSeconds: number;

  constructor(db: Kysely<Db>, sessionTtlSeconds = 60 * 60 * 24 * 7) {
    this.#db = db;
    this.#sessionTtlSeconds = sessionTtlSeconds;
  }

  async createUser(username: string, password: string, role: Role): Promise<string> {
    if (password.length < 8) throw new Error("password must be at least 8 characters");
    const id = uuidv7();
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    await this.#db
      .insertInto("users")
      .values({ id, username, passwordHash, role, active: 1, createdAt: new Date().toISOString() })
      .execute();
    return id;
  }

  /**
   * Secure one-time bootstrap (wave 2, TAN-002). The "no users yet" check and
   * the insert run inside one database transaction, so concurrent bootstrap
   * requests serialize at the database level: exactly one initial
   * administrator can ever be created. Later calls fail closed with a
   * product-facing message — they never overwrite or add accounts.
   */
  async createInitialAdmin(
    username: string,
    password: string,
  ): Promise<{ ok: true; userId: string } | { ok: false; reason: "closed" | "invalid" }> {
    if (password.length < 8 || username.trim().length === 0) return { ok: false, reason: "invalid" };
    try {
      return await this.#db
        .transaction()
        .execute(async (trx) => {
          // Updating one singleton row acquires a database write lock before
          // the users-table check. This serializes different usernames on
          // both SQLite and PostgreSQL without storing bootstrap state here.
          await trx
            .updateTable("bootstrap_lock")
            .set({ touchedAt: new Date().toISOString() })
            .where("id", "=", "global")
            .execute();
          const [existing] = await trx.selectFrom("users").select("id").limit(1).execute();
          if (existing) return { ok: false as const, reason: "closed" as const };
          const id = uuidv7();
          const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
          await trx
            .insertInto("users")
            .values({ id, username, passwordHash, role: "admin", active: 1, createdAt: new Date().toISOString() })
            .execute();
          return { ok: true as const, userId: id };
        });
    } catch (err) {
      // A UNIQUE violation on username means the admin exists already.
      const msg = String((err as Error).message ?? "");
      if (/UNIQUE/i.test(msg)) return { ok: false, reason: "closed" };
      throw err;
    }
  }

  /** Public first-run probe. Bootstrap state derives only from the users table. */
  async isBootstrapRequired(): Promise<boolean> {
    const [existing] = await this.#db.selectFrom("users").select("id").limit(1).execute();
    return !existing;
  }

  async verifyPassword(username: string, password: string): Promise<{ userId: string; role: Role } | null> {
    const [user] = await this.#db
      .selectFrom("users")
      .selectAll()
      .where("username", "=", username)
      .execute();
    if (!user) return null;
    // Wave 9 (TAN-032): deactivated accounts fail closed.
    if (user.active === 0) return null;
    const ok = await argon2.verify(user.passwordHash, password);
    return ok ? { userId: user.id, role: user.role as Role } : null;
  }

  /** Create an opaque session. Only the SHA-256 of the token is persisted. */
  async createSession(userId: string): Promise<{ token: string; csrfToken: string; expiresAt: Date }> {
    const token = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(32).toString("base64url");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.#sessionTtlSeconds * 1000);
    await this.#db
      .insertInto("sessions")
      .values({
        tokenHash: sha256(token),
        userId,
        csrfToken,
        createdAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
      })
      .execute();
    return { token, csrfToken, expiresAt };
  }

  async getSession(token: string): Promise<SessionInfo | null> {
    const [row] = await this.#db
      .selectFrom("sessions")
      .innerJoin("users", "users.id", "sessions.userId")
      .select(["sessions.csrfToken", "sessions.expiresAt", "sessions.userId", "users.role", "users.active"])
      .where("tokenHash", "=", sha256(token))
      .execute();
    if (!row) return null;
    if (row.active === 0) {
      // Wave 9 (TAN-032): a deactivated user's sessions die immediately.
      await this.destroySession(token);
      return null;
    }
    if (new Date(row.expiresAt).getTime() < Date.now()) {
      await this.destroySession(token);
      return null;
    }
    return {
      userId: row.userId,
      role: row.role as Role,
      csrfToken: row.csrfToken,
      expiresAt: row.expiresAt,
    };
  }

  async destroySession(token: string): Promise<void> {
    await this.#db.deleteFrom("sessions").where("tokenHash", "=", sha256(token)).execute();
  }

  /**
   * Create a scoped API key. Returns the plaintext once; only the SHA-256
   * hash and scope list are stored. Wave 9 (TAN-033): optional expiry.
   */
  async createApiKey(name: string, scopes: string[], expiresAt?: string | null): Promise<{ id: string; key: string }> {
    const key = `${API_KEY_PREFIX}${randomBytes(24).toString("base64url")}`;
    const id = uuidv7();
    await this.#db
      .insertInto("api_keys")
      .values({
        id,
        name,
        keyHash: sha256(key),
        scopes: JSON.stringify(scopes),
        createdAt: new Date().toISOString(),
        revokedAt: null,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
      })
      .execute();
    return { id, key };
  }

  async verifyApiKey(
    key: string,
    requiredScope?: string,
  ): Promise<ApiKeyRecord | null> {
    if (!key.startsWith(API_KEY_PREFIX)) return null;
    const [row] = await this.#db
      .selectFrom("api_keys")
      .selectAll()
      .where("keyHash", "=", sha256(key))
      .execute();
    if (!row || row.revokedAt !== null) return null;
    // Wave 9 (TAN-033): expired keys fail closed.
    if (row.expiresAt !== null && row.expiresAt !== undefined && new Date(row.expiresAt).getTime() < Date.now()) {
      return null;
    }
    let scopes: string[];
    try {
      scopes = JSON.parse(row.scopes) as string[];
    } catch {
      return null;
    }
    if (requiredScope && !scopes.includes(requiredScope)) return null;
    return { id: row.id, name: row.name, scopes };
  }

  async revokeApiKey(id: string): Promise<void> {
    await this.#db
      .updateTable("api_keys")
      .set({ revokedAt: new Date().toISOString() })
      .where("id", "=", id)
      .execute();
  }

  // ---- Wave 9 (TAN-032) user management --------------------------------

  /** Count of active administrators — the last-admin safeguard input. */
  async countActiveAdmins(): Promise<number> {
    const [row] = await this.#db
      .selectFrom("users")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("role", "=", "admin")
      .where("active", "=", 1)
      .execute();
    return Number(row?.n ?? 0);
  }

  /** Change a user's role; refuses to demote the last active administrator. */
  async setUserRole(userId: string, role: Role, actor: { userId: string | null }): Promise<void> {
    const [user] = await this.#db.selectFrom("users").selectAll().where("id", "=", userId).execute();
    if (!user) throw new Error("unknown user");
    if (user.role === "admin" && role === "viewer" && user.active === 1) {
      const admins = await this.countActiveAdmins();
      if (admins <= 1) throw new Error("cannot remove the last administrator");
    }
    await this.#db.updateTable("users").set({ role }).where("id", "=", userId).execute();
    if (role === "viewer") {
      // Demotion takes effect on live sessions immediately.
      await this.#db.deleteFrom("sessions").where("userId", "=", userId).execute();
    }
    void actor;
  }

  /** Reset a password to a new value (Argon2id) and revoke every session. */
  async resetPassword(userId: string, newPassword: string): Promise<void> {
    if (newPassword.length < 8) throw new Error("password must be at least 8 characters");
    const passwordHash = await argon2.hash(newPassword, { type: argon2.argon2id });
    const result = await this.#db
      .updateTable("users")
      .set({ passwordHash })
      .where("id", "=", userId)
      .executeTakeFirst();
    if (Number(result?.numUpdatedRows ?? 0n) === 0) throw new Error("unknown user");
    await this.#db.deleteFrom("sessions").where("userId", "=", userId).execute();
  }

  /**
   * Deactivate or reactivate an account. Deactivation revokes sessions and
   * refuses to deactivate the last active administrator.
   */
  async setUserActive(userId: string, active: boolean): Promise<void> {
    const [user] = await this.#db.selectFrom("users").selectAll().where("id", "=", userId).execute();
    if (!user) throw new Error("unknown user");
    if (!active && user.role === "admin" && user.active === 1) {
      const admins = await this.countActiveAdmins();
      if (admins <= 1) throw new Error("cannot deactivate the last administrator");
    }
    await this.#db
      .updateTable("users")
      .set({ active: active ? 1 : 0 })
      .where("id", "=", userId)
      .execute();
    if (!active) {
      await this.#db.deleteFrom("sessions").where("userId", "=", userId).execute();
    }
  }

  /** Revoke all sessions for one user without touching the account. */
  async revokeUserSessions(userId: string): Promise<number> {
    const rows = await this.#db.selectFrom("sessions").select("tokenHash").where("userId", "=", userId).execute();
    await this.#db.deleteFrom("sessions").where("userId", "=", userId).execute();
    return rows.length;
  }

  /** CSRF double-submit check for cookie-authenticated mutations. */
  static verifyCsrf(cookieToken: string | undefined, headerToken: string | undefined): boolean {
    return (
      cookieToken !== undefined &&
      headerToken !== undefined &&
      safeEqual(cookieToken, headerToken)
    );
  }
}
