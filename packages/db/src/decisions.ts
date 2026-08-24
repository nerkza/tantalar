/**
 * Wave 7 (TAN-018): durable release decisions and blocklist.
 *
 *  - release_decisions: one immutable row per accepted OR rejected release
 *    candidate, with human-readable reasons. Append-shaped history.
 *  - release_blocklist: durable blocklist with expiry policy. Expired
 *    entries stop blocking but stay listed until pruned.
 *
 * Provider outages cannot corrupt this state: writes are local-only and
 * validated; reads never depend on a live provider.
 */
import type { Kysely } from "kysely";
import { uuidv7 } from "@tantalar/contracts";
import type { Db, ReleaseDecisionsTable, ReleaseBlocklistTable } from "./index.js";

export interface ReleaseDecision {
  decisionId: string;
  itemKey: string;
  mode: "automatic" | "interactive";
  outcome: "accepted" | "rejected";
  guid: string;
  title: string;
  reasons: string[];
  overridden: boolean;
  blocked: boolean;
  decidedAt: string;
}

export interface BlocklistRecord {
  guid: string;
  itemKey: string;
  reason: string;
  expiresAt: string | null;
  createdAt: string;
}

export class DecisionStoreError extends Error {
  readonly statusCode = 400;
}

/** Human-readable sentence for a comparison reason code (TAN-018 acceptance). */
export function humanReason(code: string, detail?: { quality?: string }): string {
  switch (code) {
    case "best_quality_available":
      return `Best quality available (${detail?.quality ?? "unknown"})`;
    case "preferred_quality":
      return "Quality matches the monitoring profile";
    case "proper_repack_upgrade":
      return "Preferred over the current copy as a proper/repack";
    case "size_within_limits":
      return "Size within the configured limit";
    case "seeders_sufficient":
      return "Enough seeders";
    case "no_qualifying_release":
      return "No release met the quality profile";
    case "size_exceeds_limit":
      return "Rejected: size exceeds the configured limit";
    case "seeders_below_minimum":
      return "Rejected: too few seeders";
    case "blacklisted_release":
      return "Rejected: release is on the blocklist";
    case "quality_below_profile":
      return "Rejected: quality below the profile minimum";
    default:
      return code.replace(/_/g, " ");
  }
}

function rowToDecision(row: ReleaseDecisionsTable): ReleaseDecision {
  return {
    decisionId: row.decisionId,
    itemKey: row.itemKey,
    mode: row.mode as ReleaseDecision["mode"],
    outcome: row.outcome as ReleaseDecision["outcome"],
    guid: row.guid,
    title: row.title,
    reasons: JSON.parse(row.reasons) as string[],
    overridden: row.overridden === 1,
    blocked: row.blocked === 1,
    decidedAt: row.decidedAt,
  };
}

export class ReleaseDecisionStore {
  readonly #db: Kysely<Db>;
  constructor(db: Kysely<Db>) {
    this.#db = db;
  }

  async record(input: {
    itemKey: string;
    mode: "automatic" | "interactive";
    outcome: "accepted" | "rejected";
    guid: string;
    title: string;
    reasons: readonly string[];
    overridden?: boolean;
    blocked?: boolean;
  }): Promise<ReleaseDecision> {
    if (!input.itemKey || !input.guid) throw new DecisionStoreError("itemKey and guid required");
    const row: ReleaseDecisionsTable = {
      decisionId: uuidv7(),
      itemKey: input.itemKey,
      mode: input.mode,
      outcome: input.outcome,
      guid: input.guid,
      title: input.title,
      reasons: JSON.stringify([...input.reasons]),
      overridden: input.overridden ? 1 : 0,
      blocked: input.blocked ? 1 : 0,
      decidedAt: new Date().toISOString(),
    };
    await this.#db.insertInto("release_decisions").values(row).execute();
    return rowToDecision(row);
  }

  async listForItem(itemKey: string, limit = 100): Promise<ReleaseDecision[]> {
    const rows = await this.#db
      .selectFrom("release_decisions")
      .selectAll()
      .where("itemKey", "=", itemKey)
      .orderBy("decidedAt desc")
      .limit(Math.max(1, Math.min(500, limit)))
      .execute();
    return rows.map(rowToDecision);
  }

  // ---- Durable blocklist ---------------------------------------------------

  async block(input: { guid: string; itemKey: string; reason: string; expiresAt?: string | null }): Promise<BlocklistRecord> {
    if (!input.guid) throw new DecisionStoreError("guid required");
    const existing = await this.#db
      .selectFrom("release_blocklist")
      .selectAll()
      .where("guid", "=", input.guid)
      .executeTakeFirst();
    if (existing) {
      return {
        guid: existing.guid,
        itemKey: existing.itemKey,
        reason: existing.reason,
        expiresAt: existing.expiresAt,
        createdAt: existing.createdAt,
      };
    }
    const row: ReleaseBlocklistTable = {
      guid: input.guid,
      itemKey: input.itemKey,
      reason: input.reason || "manual block",
      expiresAt: input.expiresAt ?? null,
      createdAt: new Date().toISOString(),
    };
    await this.#db.insertInto("release_blocklist").values(row).execute();
    return { ...row };
  }

  async unblock(guid: string): Promise<boolean> {
    const result = await this.#db.deleteFrom("release_blocklist").where("guid", "=", guid).executeTakeFirst();
    return Number(result?.numDeletedRows ?? 0) > 0;
  }

  /** Guids that currently block searches (expiry policy applied at read time). */
  async activeBlockedGuids(itemKey?: string): Promise<string[]> {
    let q = this.#db.selectFrom("release_blocklist").selectAll();
    if (itemKey !== undefined) q = q.where("itemKey", "=", itemKey);
    const rows = await q.execute();
    const now = new Date().toISOString();
    return rows.filter((r) => r.expiresAt === null || r.expiresAt > now).map((r) => r.guid);
  }

  async listBlocklist(): Promise<BlocklistRecord[]> {
    const rows = await this.#db.selectFrom("release_blocklist").selectAll().orderBy("createdAt desc").execute();
    return rows.map((r) => ({
      guid: r.guid,
      itemKey: r.itemKey,
      reason: r.reason,
      expiresAt: r.expiresAt,
      createdAt: r.createdAt,
    }));
  }
}
