import { Type } from "@sinclair/typebox";
import { PluginDocumentStore, type Db } from "@tantalar/db";
import type { Kysely } from "kysely";
import type { QualityProfile } from "@tantalar/contracts";

export const qualityLabels = ["2160p", "1080p", "720p", "480p"] as const;
const quality = Type.Union(qualityLabels.map(q => Type.Literal(q)));
const size = Type.Number({ minimum: 0, maximum: 10000 });
const nullableSize = Type.Unsafe<number | null>({ type: ["number", "null"], minimum: 0, maximum: 10000 });
export const QualitySettingsBody = Type.Object({
  profiles: Type.Array(Type.Object({
    name: Type.Union([Type.Literal("any"), Type.Literal("hd"), Type.Literal("uhd")]),
    preferredQualities: Type.Array(quality, { minItems: 1, maxItems: 4, uniqueItems: true }),
    upgradeAllowed: Type.Boolean(), cutoff: quality, preferProperRepack: Type.Boolean(),
  }, { additionalProperties: false }), { minItems: 3, maxItems: 3 }),
  sizes: Type.Object(Object.fromEntries(["movie", "series"].map(kind => [kind, Type.Object(Object.fromEntries(qualityLabels.map(q => [q, Type.Object({ min: size, preferred: nullableSize, max: nullableSize }, { additionalProperties: false })])), { additionalProperties: false })])), { additionalProperties: false }),
  recycleBinDays: Type.Integer({ minimum: 0, maximum: 3650 }),
}, { additionalProperties: false });

export interface QualityConfiguration {
  profiles: Array<QualityProfile & { upgradeAllowed: boolean; cutoff: string; preferProperRepack: boolean }>;
  sizes: Record<"movie" | "series", Record<string, { min: number; preferred: number | null; max: number | null }>>;
  recycleBinDays: number;
}
export function defaultQualityConfiguration(): QualityConfiguration {
  return {
    profiles: [
      { name: "any", preferredQualities: [...qualityLabels], upgradeAllowed: true, cutoff: "2160p", preferProperRepack: true },
      { name: "hd", preferredQualities: ["1080p", "720p"], upgradeAllowed: true, cutoff: "1080p", preferProperRepack: true },
      { name: "uhd", preferredQualities: ["2160p", "1080p"], upgradeAllowed: true, cutoff: "2160p", preferProperRepack: true },
    ],
    // Resolution-level adaptation of Arr WEB defaults. Source-specific qualities remain a separate model extension.
    sizes: {
      movie: { "480p": { min: 0, preferred: 95, max: 100 }, "720p": { min: 0, preferred: 95, max: 100 }, "1080p": { min: 0, preferred: 95, max: 100 }, "2160p": { min: 0, preferred: null, max: null } },
      series: { "480p": { min: 2, preferred: 95, max: 100 }, "720p": { min: 3, preferred: 95, max: 130 }, "1080p": { min: 4, preferred: 95, max: 130 }, "2160p": { min: 35, preferred: 95, max: null } },
    },
    recycleBinDays: 7,
  };
}
export class QualitySettings {
  private readonly store: PluginDocumentStore;
  constructor(private readonly db: Kysely<Db>) { this.store = new PluginDocumentStore(db); }
  async installed(itemKey: string) {
    return this.db.selectFrom("media_catalog").selectAll().where("itemKey", "=", itemKey).orderBy("updatedAt", "desc").executeTakeFirst();
  }
  async read(): Promise<QualityConfiguration> {
    return (await this.store.get("dev.tantalar.core.quality", "settings"))?.doc as QualityConfiguration ?? defaultQualityConfiguration();
  }
  async save(value: QualityConfiguration): Promise<void> {
    if (new Set(value.profiles.map(p => p.name)).size !== 3 || value.profiles.some(p => !p.preferredQualities.includes(p.cutoff))) {
      throw Object.assign(new Error("Each profile needs a unique name and an allowed cutoff quality."), { statusCode: 400 });
    }
    for (const definitions of Object.values(value.sizes)) for (const rule of Object.values(definitions)) {
      if ((rule.max !== null && rule.max < rule.min) || (rule.preferred !== null && (rule.preferred < rule.min || rule.max !== null && rule.preferred > rule.max))) {
        throw Object.assign(new Error("Size values must satisfy minimum ≤ preferred ≤ maximum."), { statusCode: 400 });
      }
    }
    await this.store.put("dev.tantalar.core.quality", "settings", value);
  }
  async effective(profile: QualityProfile, kind: "movie" | "series", runtimeMinutes?: number): Promise<QualityProfile> {
    const settings = await this.read();
    const configured = settings.profiles.find(p => p.name === profile.name);
    return { ...profile, ...configured, sizeDefinitions: settings.sizes[kind], ...(runtimeMinutes && runtimeMinutes > 0 ? { runtimeMinutes } : {}) };
  }
}

/** Size chooses between eligible releases; it never makes an installed file an upgrade candidate. */
export function qualityUpgradeReason(profile: QualityProfile, installed: string, candidate: string): string | null {
  if (!profile.upgradeAllowed) return "Quality upgrades are disabled.";
  const order = profile.preferredQualities.length ? profile.preferredQualities : qualityLabels;
  const current = order.indexOf(installed), next = order.indexOf(candidate), cutoff = order.indexOf(profile.cutoff ?? order[0]!);
  if (next < 0) return "Release quality is not allowed.";
  if (installed === "unknown") return "Installed quality is unknown. Identify the file before replacing it.";
  if (current >= 0 && cutoff >= 0 && current <= cutoff) return "Quality cutoff is already met.";
  if (current >= 0 && next >= current) return "Release is not a quality upgrade.";
  // The importer also refuses resolution downgrades, including unusual user ranking orders.
  if (Number.parseInt(candidate) <= Number.parseInt(installed)) return "Release is not a resolution upgrade.";
  return null;
}
