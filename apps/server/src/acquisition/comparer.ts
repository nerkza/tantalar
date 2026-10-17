/**
 * Built-in release-comparison engine (phase 3b, story 5/6).
 * A deep module: callers give candidates + a quality profile; it returns a
 * verdict. External behavior only — scoring internals are private and free
 * to change as long as the verdict contract holds.
 *
 * Provided through `dev.tantalar.capability.release-comparer` so a plugin may
 * replace it (capability is built-in-provided, replaceable).
 */
import {
  EventTypes,
  parseQualityLabel,
  isProperOrRepack,
  type CandidateRelease,
  type ComparisonReason,
  type ComparisonVerdict,
  type QualityProfile,
} from "@tantalar/contracts";
import { createHash } from "node:crypto";
import { qualityUpgradeReason } from "../quality-settings.js";

export interface CompareInput {
  readonly candidates: ReadonlyArray<CandidateRelease>;
  readonly profile: QualityProfile;
  readonly blacklistedGuids?: readonly string[];
}

const QUALITY_ORDER = ["2160p", "1080p", "720p", "480p", "unknown"];

function qualityRank(q: string, preferred: readonly string[]): number {
  const idx = preferred.length > 0 ? preferred.indexOf(q) : QUALITY_ORDER.indexOf(q);
  return idx === -1 ? QUALITY_LENGTH : idx;
}
const QUALITY_LENGTH = QUALITY_ORDER.length;
const REJECTION_REASONS = new Set<ComparisonReason>([
  "blacklisted_release",
  "size_exceeds_limit",
  "size_below_minimum",
  "runtime_unknown",
  "not_quality_upgrade",
  "seeders_below_minimum",
  "seeders_not_reported",
  "quality_below_profile",
  "language_not_allowed",
]);

/** Rank candidates best-first; returns rejection reasons for the losers. */
export function compareReleases(input: CompareInput): ComparisonVerdict & { events: typeof EventTypes[keyof typeof EventTypes][] } {
  const blacklisted = new Set(input.blacklistedGuids ?? []);
  const preferred = [...new Set(input.profile.preferredQualities.map(parseQualityLabel))];
  const languages = [...new Set((input.profile.preferredLanguages ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean))];
  const assessed = input.candidates.map((candidate) => {
    const reasons: ComparisonReason[] = [];
    if (input.profile.installedQuality && qualityUpgradeReason(input.profile, input.profile.installedQuality, candidate.quality)) reasons.push("not_quality_upgrade");
    const sizeRule = input.profile.sizeDefinitions?.[candidate.quality];
    if (sizeRule) {
      const runtime = input.profile.runtimeMinutes;
      if (!runtime || !Number.isFinite(runtime) || runtime <= 0) reasons.push("runtime_unknown");
      else {
        const mbPerMinute = candidate.release.sizeBytes / (1024 * 1024 * runtime);
        if (mbPerMinute < sizeRule.min) reasons.push("size_below_minimum");
        if (sizeRule.max !== null && mbPerMinute > sizeRule.max) reasons.push("size_exceeds_limit");
      }
    }
    if (blacklisted.has(candidate.release.guid)) reasons.push("blacklisted_release");
    if (input.profile.maxSizeBytes !== undefined) {
      reasons.push(candidate.release.sizeBytes > input.profile.maxSizeBytes ? "size_exceeds_limit" : "size_within_limits");
    }
    if (input.profile.minSeeders !== undefined) {
      reasons.push(
        candidate.release.seeders === undefined
          ? "seeders_not_reported"
          : candidate.release.seeders < input.profile.minSeeders
            ? "seeders_below_minimum"
            : "seeders_sufficient",
      );
    }
    if (preferred.length > 0) {
      reasons.push(preferred.includes(candidate.quality) ? "preferred_quality" : "quality_below_profile");
    }
    if (languages.length > 0) {
      reasons.push(
        candidate.release.language === undefined
          ? "language_not_reported"
          : languages.includes(candidate.release.language.trim().toLowerCase())
            ? "language_allowed"
            : "language_not_allowed",
      );
    }
    return {
      candidate,
      accepted: !reasons.some((reason) => REJECTION_REASONS.has(reason)),
      reasons,
    };
  });
  const eligible = assessed.filter((assessment) => assessment.accepted).map((assessment) => assessment.candidate);

  const ranked = [...eligible].sort((a, b) => {
    const q = qualityRank(a.quality, preferred) - qualityRank(b.quality, preferred);
    if (q !== 0) return q;
    const proper = Number(b.properOrRepack) - Number(a.properOrRepack);
    if (proper !== 0 && input.profile.preferProperRepack !== false) return proper;
    const seed = (b.release.seeders ?? 0) - (a.release.seeders ?? 0);
    if (seed !== 0) return seed;
    const rule = input.profile.sizeDefinitions?.[a.quality];
    if (rule && input.profile.runtimeMinutes) {
      const target = rule.preferred === null ? null : rule.preferred * 1024 * 1024 * input.profile.runtimeMinutes;
      return target === null ? b.release.sizeBytes - a.release.sizeBytes : Math.abs(a.release.sizeBytes - target) - Math.abs(b.release.sizeBytes - target);
    }
    return a.release.sizeBytes - b.release.sizeBytes;
  });

  const winner = ranked[0] ?? null;
  const properDecidedRank = winner?.properOrRepack === true
    && input.profile.preferProperRepack !== false
    && ranked.some((candidate) => candidate.release.guid !== winner.release.guid
      && candidate.quality === winner.quality
      && !candidate.properOrRepack);
  const rankReason: ComparisonReason | null = winner
    ? properDecidedRank
      ? "proper_repack_upgrade"
      : "best_quality_available"
    : null;
  const assessments = assessed.map(({ candidate, accepted, reasons }) => ({
    guid: candidate.release.guid,
    accepted,
    reasons: [
      ...reasons.filter((reason) => accepted || REJECTION_REASONS.has(reason)),
      ...(accepted ? [candidate.release.guid === winner?.release.guid ? rankReason! : "eligible_lower_ranked" as const] : []),
    ],
  }));
  const winnerAssessment = assessments.find((assessment) => assessment.guid === winner?.release.guid);
  const reasons: ComparisonReason[] = winnerAssessment ? [...winnerAssessment.reasons] : ["no_qualifying_release"];
  const rejected = assessments.flatMap((assessment) => {
    const reason = assessment.reasons.find((candidate) => REJECTION_REASONS.has(candidate));
    return reason ? [{ guid: assessment.guid, reason }] : [];
  });

  return {
    winnerGuid: winner ? winner.release.guid : null,
    rankedGuids: ranked.map((c) => c.release.guid),
    reasons,
    rejected,
    assessments,
    events: [EventTypes.ComparisonVerdict],
  };
}

export function toCandidate(release: import("@tantalar/contracts").IndexedRelease): CandidateRelease {
  return {
    release,
    quality: parseQualityLabel(release.title),
    properOrRepack: isProperOrRepack(release.title),
  };
}

/** Opaque browser/event identity. Raw provider GUIDs can contain private URLs. */
export function releaseFingerprint(candidate: CandidateRelease): string {
  return createHash("sha256")
    .update(`${candidate.release.indexerId}\0${candidate.release.guid}`)
    .digest("hex");
}
