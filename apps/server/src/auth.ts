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
      .values({ id, username, passwordHash, role, createdAt: new Date().toISOString() })
      .execute();
    return id;
  }

  async verifyPassword(username: string, password: string): Promise<{ userId: string; role: Role } | null> {
    const [user] = await this.#db
      .selectFrom("users")
      .selectAll()
      .where("username", "=", username)
      .execute();
    if (!user) return null;
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
      .select(["sessions.csrfToken", "sessions.expiresAt", "sessions.userId", "users.role"])
      .where("tokenHash", "=", sha256(token))
      .execute();
    if (!row) return null;
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
   * hash and scope list are stored.
   */
  async createApiKey(name: string, scopes: string[]): Promise<{ id: string; key: string }> {
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

  /** CSRF double-submit check for cookie-authenticated mutations. */
  static verifyCsrf(cookieToken: string | undefined, headerToken: string | undefined): boolean {
    return (
      cookieToken !== undefined &&
      headerToken !== undefined &&
      safeEqual(cookieToken, headerToken)
    );
  }
}
