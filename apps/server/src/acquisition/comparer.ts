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

export interface CompareInput {
  readonly candidates: ReadonlyArray<CandidateRelease>;
  readonly profile: QualityProfile;
  readonly blacklistedGuids?: readonly string[];
}

const QUALITY_ORDER = ["2160p", "1080p", "720p", "480p", "unknown"];

function qualityRank(q: string): number {
  const idx = QUALITY_ORDER.indexOf(q);
  return idx === -1 ? QUALITY_LENGTH : idx;
}
const QUALITY_LENGTH = QUALITY_ORDER.length;

/** Rank candidates best-first; returns rejection reasons for the losers. */
export function compareReleases(input: CompareInput): ComparisonVerdict & { events: typeof EventTypes[keyof typeof EventTypes][] } {
  const blacklisted = new Set(input.blacklistedGuids ?? []);
  const rejected: Array<{ guid: string; reason: ComparisonReason }> = [];
  const eligible: CandidateRelease[] = [];

  for (const c of input.candidates) {
    if (blacklisted.has(c.release.guid)) {
      rejected.push({ guid: c.release.guid, reason: "blacklisted_release" });
      continue;
    }
    if (input.profile.maxSizeBytes !== undefined && c.release.sizeBytes > input.profile.maxSizeBytes) {
      rejected.push({ guid: c.release.guid, reason: "size_exceeds_limit" });
      continue;
    }
    if (
      input.profile.minSeeders !== undefined &&
      (c.release.seeders === undefined || c.release.seeders < input.profile.minSeeders)
    ) {
      rejected.push({ guid: c.release.guid, reason: "seeders_below_minimum" });
      continue;
    }
    eligible.push(c);
  }

  const ranked = [...eligible].sort((a, b) => {
    // proper/repack upgrade first, then quality rank, then seeders, then size.
    const proper = Number(b.properOrRepack) - Number(a.properOrRepack);
    if (proper !== 0 && input.profile.preferProperRepack !== false) return proper;
    const q = qualityRank(a.quality) - qualityRank(b.quality);
    if (q !== 0) return q;
    const seed = (b.release.seeders ?? 0) - (a.release.seeders ?? 0);
    if (seed !== 0) return seed;
    return a.release.sizeBytes - b.release.sizeBytes;
  });

  const winner = ranked[0] ?? null;
  const reasons: ComparisonReason[] = winner
    ? [
        winner.properOrRepack ? "proper_repack_upgrade" : "best_quality_available",
        "preferred_quality",
        ...(winner.quality !== "unknown" ? (["size_within_limits"] as const) : []),
      ]
    : ["no_qualifying_release"];

  return {
    winnerGuid: winner ? winner.release.guid : null,
    rankedGuids: ranked.map((c) => c.release.guid),
    reasons,
    rejected,
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
