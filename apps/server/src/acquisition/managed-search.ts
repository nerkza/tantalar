import {
  EventTypes,
  uuidv7,
  validateIndexedRelease,
  type CandidateRelease,
  type QualityProfile,
} from "@tantalar/contracts";
import { humanReason, type ReleaseDecisionStore, type PluginDocumentStore } from "@tantalar/db";
import type { DownloadJobStore } from "@tantalar/db";
import type { ServiceContainer } from "../container.js";
import type { EventBus } from "../events.js";
import { compareReleases, releaseFingerprint, toCandidate } from "./comparer.js";
import { GrabPipeline } from "./pipeline.js";
import type { QualitySettings } from "../quality-settings.js";
import { createMovieMetadataService } from "../movie-metadata.js";

export function normalizeQualityProfile(value: unknown): QualityProfile {
  const profile = value as Partial<QualityProfile> | null;
  return profile && typeof profile === "object" && typeof profile.name === "string" && Array.isArray(profile.preferredQualities)
    ? {
        name: profile.name.slice(0, 80),
        preferredQualities: profile.preferredQualities.filter((quality): quality is string => typeof quality === "string").slice(0, 20),
        ...(Array.isArray(profile.preferredLanguages)
          ? { preferredLanguages: profile.preferredLanguages.filter((language): language is string => typeof language === "string").slice(0, 20) }
          : {}),
        ...(typeof profile.minSeeders === "number" ? { minSeeders: profile.minSeeders } : {}),
        ...(typeof profile.maxSizeBytes === "number" ? { maxSizeBytes: profile.maxSizeBytes } : {}),
        ...(typeof profile.preferProperRepack === "boolean" ? { preferProperRepack: profile.preferProperRepack } : {}),
      }
    : { name: "hd", preferredQualities: ["1080p", "720p"] };
}

export interface ManagedWantedItem {
  kind: "movie" | "series";
  id: string;
  itemKey: string;
  query: string;
  episodeKey?: string;
}

export async function listManagedWanted(container: ServiceContainer): Promise<ManagedWantedItem[]> {
  const items: ManagedWantedItem[] = [];
  if (container.hasProviders("dev.tantalar.capability.automation.movies")) {
    const scan = await container.resolve("dev.tantalar.capability.automation.movies").invoke("scan", {}) as {
      wanted?: Array<{ movieId?: unknown; query?: unknown }>;
    };
    for (const movie of scan.wanted ?? []) {
      if (typeof movie.movieId !== "string") continue;
      const query = typeof movie.query === "string" && movie.query.trim() ? movie.query.trim().slice(0, 300) : movie.movieId;
      items.push({ kind: "movie", id: movie.movieId, itemKey: movie.movieId, query });
    }
  }
  if (container.hasProviders("dev.tantalar.capability.automation.series")) {
    const scan = await container.resolve("dev.tantalar.capability.automation.series").invoke("wanted", {}) as {
      wanted?: Array<{ seriesId?: unknown; episodeKey?: unknown; query?: unknown }>;
    };
    for (const episode of scan.wanted ?? []) {
      if (typeof episode.seriesId !== "string" || typeof episode.episodeKey !== "string") continue;
      const query = typeof episode.query === "string" && episode.query.trim()
        ? episode.query.trim().slice(0, 300)
        : `${episode.seriesId} ${episode.episodeKey}`;
      items.push({
        kind: "series",
        id: episode.seriesId,
        itemKey: `${episode.seriesId}:${episode.episodeKey}`,
        episodeKey: episode.episodeKey,
        query,
      });
    }
  }
  return items;
}

function availabilityMet(minimum: unknown, availableAt: unknown): boolean {
  if (minimum === "announced") return true;
  if (typeof availableAt !== "string") return false;
  const timestamp = Date.parse(availableAt);
  return Number.isFinite(timestamp) && timestamp <= Date.now();
}

export async function managedReleaseContext(
  container: ServiceContainer,
  kind: "movie" | "series",
  id: string,
  requestedEpisodeKey?: string,
) {
  if (kind === "movie") {
    const movie = await container.resolve("dev.tantalar.capability.automation.movies").invoke("get-movie", { movieId: id }) as Record<string, unknown>;
    const title = String(movie.title ?? "").slice(0, 300);
    if (!title) throw new Error("Managed movie not found.");
    const year = typeof movie.year === "number" ? Math.trunc(movie.year) : 0;
    return {
      itemKey: id,
      title,
      query: `${title}${year ? ` ${year}` : ""}`,
      categories: [1000],
      profile: normalizeQualityProfile(movie.profile),
      availabilityMet: availabilityMet(movie.minimumAvailability, movie.availableAt),
    };
  }

  const provider = container.resolve("dev.tantalar.capability.automation.series");
  const series = await provider.invoke("get-series", { seriesId: id }) as Record<string, unknown>;
  const title = String(series.name ?? "").slice(0, 300);
  if (!title) throw new Error("Managed series not found.");
  const wanted = await provider.invoke("wanted", {}) as { wanted?: Array<{ seriesId?: unknown; episodeKey?: unknown; query?: unknown }> };
  const episode = wanted.wanted?.find((item) => item.seriesId === id && (!requestedEpisodeKey || item.episodeKey === requestedEpisodeKey))
    ?? (requestedEpisodeKey && Array.isArray(series.episodes)
      ? series.episodes.find((item) => item?.episodeKey === requestedEpisodeKey) as { episodeKey?: unknown; query?: unknown } | undefined
      : undefined);
  if (!episode) throw new Error("This series has no matching wanted episode.");
  const episodeKey = String(episode.episodeKey ?? "");
  const episodeRecord = Array.isArray(series.episodes)
    ? series.episodes.find((value) => value && typeof value === "object" && (value as Record<string, unknown>).episodeKey === episodeKey) as Record<string, unknown> | undefined
    : undefined;
  const match = /^S(\d+)E(\d+)$/.exec(episodeKey);
  return {
    itemKey: `${id}:${episodeKey}`,
    title: `${title} ${episodeKey}`,
    query: String(episode.query ?? `${title} ${episodeKey}`).slice(0, 300),
    categories: [2000],
    ...(match ? { season: Number(match[1]), episode: Number(match[2]) } : {}),
    profile: normalizeQualityProfile(series.profile),
    availabilityMet: availabilityMet(series.minimumAvailability, episodeRecord?.airDate),
  };
}

export async function searchManagedReleases(
  container: ServiceContainer,
  decisions: ReleaseDecisionStore,
  kind: "movie" | "series",
  id: string,
  mode: "automatic" | "interactive",
  episodeKey?: string,
  bus?: EventBus,
  query?: string,
  parentRunId?: string,
  qualitySettings?: QualitySettings,
) {
  const context = await managedReleaseContext(container, kind, id, episodeKey);
  if (qualitySettings) {
    const record = await container.resolve(`dev.tantalar.capability.automation.${kind === "movie" ? "movies" : "series"}`)
      .invoke(kind === "movie" ? "get-movie" : "get-series", kind === "movie" ? { movieId: id } : { seriesId: id }) as Record<string, unknown>;
    const snapshot = await createMovieMetadataService(container).resolveMovieSnapshot({ ...record, kind }).catch(() => null);
    const episode = Array.isArray(record.episodes) ? record.episodes.find(e => e.episodeKey === episodeKey) : undefined;
    // Radarr uses 110 minutes when movie runtime is unavailable; episodes require a known runtime.
    const runtime = kind === "movie" ? snapshot?.runtimeMinutes ?? 110 : episode?.runtimeMinutes ?? snapshot?.runtimeMinutes;
    context.profile = await qualitySettings.effective(context.profile, kind, runtime);
    const installed = await qualitySettings.installed(context.itemKey);
    if (installed) context.profile = { ...context.profile, installedQuality: installed.quality };
  }
  const providers = container.providers("dev.tantalar.capability.indexer");
  if (providers.length === 0) throw new Error("No indexer provider is mounted.");
  const correlationId = parentRunId ?? uuidv7();
  const settled = await Promise.allSettled(providers.map((provider) => provider.invoke("search", {
    mode,
    query: query?.trim() || context.query,
    categories: context.categories,
    limit: 50,
    correlationId,
    ...(context.season !== undefined ? { season: context.season } : {}),
    ...(context.episode !== undefined ? { episode: context.episode } : {}),
  })));
  const byGuid = new Map<string, CandidateRelease>();
  const failures: Array<{ indexerId: string; reason: string }> = [];
  for (const [index, result] of settled.entries()) {
    const provider = providers[index]!;
    if (result.status === "rejected") {
      failures.push({ indexerId: provider.pluginId, reason: "unavailable" });
      continue;
    }
    const releases = (result.value as { releases?: unknown[] } | null)?.releases;
    if (!Array.isArray(releases)) continue;
    for (const release of releases) {
      try {
        const validated = validateIndexedRelease(release);
        if (!byGuid.has(validated.guid)) byGuid.set(validated.guid, toCandidate(validated));
      } catch {
        // One malformed row does not discard valid results from the same provider.
      }
    }
  }
  const candidates = [...byGuid.values()];
  const blacklistedGuids = await decisions.activeBlockedGuids(context.itemKey);
  const compared = compareReleases({ candidates, profile: context.profile, blacklistedGuids });
  const unavailableAssessments = (compared.assessments ?? []).map((assessment) => ({
    guid: assessment.guid,
    accepted: false,
    reasons: [
      ...(assessment.accepted ? [] : assessment.reasons),
      "availability_not_met" as const,
    ],
  }));
  const verdict = context.availabilityMet
    ? compared
    : {
        winnerGuid: null,
        rankedGuids: [],
        reasons: ["no_qualifying_release" as const],
        rejected: unavailableAssessments.map((assessment) => ({
          guid: assessment.guid,
          reason: assessment.reasons[0] ?? "availability_not_met" as const,
        })),
        assessments: unavailableAssessments,
        events: compared.events,
      };
  if (bus) {
    const candidateByGuid = new Map(candidates.map((candidate) => [candidate.release.guid, candidate]));
    await bus.publish({
      type: EventTypes.ReleaseDecisionRecorded,
      producer: "core",
      subject: context.itemKey,
      correlationId,
      payload: {
        itemKey: context.itemKey,
        mode,
        winnerCandidateId: verdict.winnerGuid
          ? releaseFingerprint(candidateByGuid.get(verdict.winnerGuid)!)
          : null,
        assessments: (verdict.assessments ?? []).map((assessment) => {
          const candidate = candidateByGuid.get(assessment.guid)!;
          return {
            candidateId: releaseFingerprint(candidate),
            title: candidate.release.title,
            kind: candidate.release.kind,
            indexerId: candidate.release.indexerId,
            quality: candidate.quality,
            accepted: assessment.accepted,
            reasons: assessment.reasons.map((code) => ({
              code,
              message: humanReason(code, { quality: candidate.quality }),
            })),
          };
        }),
        failures,
      },
    });
  }
  return { context, candidates, verdict, failures, blacklistedGuids, correlationId };
}

export async function runAutomaticAcquisition(
  container: ServiceContainer,
  decisions: ReleaseDecisionStore,
  jobs: DownloadJobStore,
  bus: EventBus,
  limit = 20,
  parentRunId?: string,
  qualitySettings?: QualitySettings,
  progress?: PluginDocumentStore,
) {
  const tasks = await listManagedWanted(container);
  tasks.sort((a, b) => a.itemKey.localeCompare(b.itemKey));
  const cursor = (await progress?.get("dev.tantalar.core.jobs", "wanted-cursor"))?.doc;
  const start = typeof cursor === "string" ? tasks.findIndex(task => task.itemKey.localeCompare(cursor) > 0) : 0;
  const batch = tasks.slice(Math.max(0, start), Math.max(0, start) + Math.max(1, Math.min(100, limit)));
  const activeKeys = new Set((await jobs.list()).filter(job => !job.removed && (job.state === "completed" ? !job.importHandoffPath : !["failed", "cancelled"].includes(job.state))).map(job => job.itemKey));
  const pipeline = new GrabPipeline({ bus, container, jobs });
  let searched = 0;
  let grabbed = 0;
  let failed = 0;
  let skipped = Math.max(0, tasks.length - batch.length);
  for (const task of batch) {
    if (activeKeys.has(task.itemKey)) {
      skipped++;
      continue;
    }
    try {
      const result = await searchManagedReleases(container, decisions, task.kind, task.id, "automatic", task.episodeKey, bus, undefined, parentRunId, qualitySettings);
      if (result.failures.length && !result.candidates.length) { failed++; continue; }
      searched++;
      if (!result.context.availabilityMet) {
        const candidate = result.candidates[0];
        if (candidate) {
          await decisions.record({
            itemKey: result.context.itemKey,
            mode: "automatic",
            outcome: "rejected",
            guid: candidate.release.guid,
            title: candidate.release.title,
            reasons: [humanReason("availability_not_met", { quality: candidate.quality })],
          });
        }
        skipped++;
        continue;
      }
      const dispatch = await pipeline.decide({
        itemKey: result.context.itemKey,
        candidates: result.candidates,
        profile: result.context.profile,
        blacklistedGuids: result.blacklistedGuids,
        mode: "automatic",
        correlationId: result.correlationId,
      });
      const chosen = result.candidates.find((candidate) => candidate.release.guid === dispatch.verdict.winnerGuid)
        ?? result.candidates[0];
      if (chosen) {
        await decisions.record({
          itemKey: result.context.itemKey,
          mode: "automatic",
          outcome: dispatch.grabbed ? "accepted" : "rejected",
          guid: chosen.release.guid,
          title: chosen.release.title,
          reasons: (dispatch.grabbed ? dispatch.verdict.reasons : [dispatch.blockedReason ?? "no_qualifying_release"])
            .map((reason) => humanReason(reason, { quality: chosen.quality })),
        });
      }
      if (dispatch.grabbed) {
        grabbed++;
        activeKeys.add(result.context.itemKey);
      }
    } catch {
      failed++;
    }
  }
  if (batch.length) await progress?.put("dev.tantalar.core.jobs", "wanted-cursor", batch[batch.length - 1]!.itemKey);
  return { eligible: tasks.length, searched, grabbed, skipped, failed };
}
