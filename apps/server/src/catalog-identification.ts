import { basename, extname } from "node:path";
import type { ServiceContainer } from "./container.js";

/** Episode markers override a library's default type. Explicit matches override both. */
export function catalogIdentity(path: string, itemKey = "", defaultKind: "movie" | "series" | "mixed" = "movie") {
  const filename = basename(path, extname(path)).replace(/[._]+/g, " ");
  const episode = /\bS(\d{1,3})E(\d{1,4})\b/i.exec(filename);
  const year = /\(((?:19|20)\d{2})\)/.exec(filename)
    ?? [...filename.matchAll(/\b((?:19|20)\d{2})\b/g)].filter(match => match.index > 0).at(-1);
  const end = episode?.index ?? year?.index ?? filename.search(/\b(?:bluray|web[ -]?dl|webrip|hdtv|dvdrip|\d{3,4}p)\b/i);
  const title = (end >= 0 ? filename.slice(0, end) : filename).replace(/[\s([\]-]+$/, "").trim();
  return {
    title,
    kind: itemKey.startsWith("series-") ? "series" as const : itemKey.startsWith("movie-") ? "movie" as const : episode || defaultKind === "series" ? "series" as const : "movie" as const,
    ...(year && !episode ? { year: Number(year[1]) } : {}),
    ...(episode ? { episodeKey: `S${episode[1]!.padStart(2, "0")}E${episode[2]!.padStart(2, "0")}` } : {}),
  };
}

const normalized = (value: unknown) => String(value ?? "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/** Only unique exact title/year matches are automatic. Ambiguous files remain available for manual identification. */
export async function identifyCatalogFile(container: ServiceContainer, path: string, libraryId: string, libraryKind: "movie" | "series" | "mixed" = "movie"): Promise<string | null> {
  const identity = catalogIdentity(path, "", libraryKind);
  if (!identity.title || identity.kind === "series" && !identity.episodeKey) return null;
  const metadata = container.resolve("dev.tantalar.capability.metadata-provider");
  const response = await metadata.invoke("search", { kind: identity.kind, query: identity.title, limit: 10 }) as { candidates?: Array<Record<string, unknown>> };
  const candidates = (response.candidates ?? []).filter(candidate => candidate.kind === identity.kind
    && normalized(candidate.name) === normalized(identity.title)
    && (identity.year === undefined || candidate.year === identity.year));
  if (candidates.length !== 1) return null;
  const candidate = candidates[0]!;
  if (typeof candidate.externalId !== "string" || typeof candidate.provider !== "string") return null;
  const provider = container.resolve(`dev.tantalar.capability.automation.${identity.kind === "movie" ? "movies" : "series"}`);
  const listed = await provider.invoke(identity.kind === "movie" ? "list-movies" : "list-series", {}) as Record<string, Array<Record<string, unknown>>>;
  const existing = (listed[identity.kind === "movie" ? "movies" : "series"] ?? []).find(item => item.externalId === candidate.externalId && item.provider === candidate.provider);
  let id = existing?.[identity.kind === "movie" ? "movieId" : "seriesId"];
  if (!id) {
    const details = await metadata.invoke("details", { kind: identity.kind, externalId: candidate.externalId, name: candidate.name }) as { found?: boolean; metadata?: Record<string, unknown>; episodes?: Array<Record<string, unknown>> };
    if (!details.found || !details.metadata) return null;
    if (details.metadata.kind !== identity.kind || details.metadata.externalId !== candidate.externalId || details.metadata.provider !== candidate.provider) return null;
    if (identity.kind === "series" && !details.episodes?.some(ep => `S${String(ep.season).padStart(2, "0")}E${String(ep.episode).padStart(2, "0")}` === identity.episodeKey)) return null;
    const result = await provider.invoke(identity.kind === "movie" ? "add-movie" : "add-series", {
      ...candidate, ...details.metadata,
      title: details.metadata.name ?? candidate.name, name: details.metadata.name ?? candidate.name,
      destinationLibraryId: libraryId, monitored: false, monitorMode: "none",
      ...(details.episodes ? { episodes: details.episodes } : {}),
    }) as Record<string, unknown>;
    id = result[identity.kind === "movie" ? "movieId" : "seriesId"];
  }
  if (typeof id !== "string") return null;
  await provider.invoke("mark-acquired", identity.kind === "movie"
    ? { movieId: id, guid: `file:${path}` }
    : { seriesId: id, episodeKey: identity.episodeKey }) as { marked?: boolean };
  return identity.kind === "movie" ? id : `${id}:${identity.episodeKey}`;
}
