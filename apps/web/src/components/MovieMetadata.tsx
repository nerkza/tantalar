import { useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import type { MoviePresentation } from "../api";
import { metadataLabel } from "../state-label";
import "./movie-metadata.css";

export function MediaArtwork({ src, title, variant = "poster", compact = false }: {
  src?: string;
  title: string;
  variant?: "poster" | "backdrop";
  compact?: boolean;
}) {
  const [failedSource, setFailedSource] = useState<string>();
  const label = `${title} ${variant}`;
  return (
    <div className="tantalar-movie-artwork" data-variant={variant} data-compact={compact}>
      {src && src !== failedSource ? (
        <img src={src} alt={label} loading="lazy" decoding="async" onError={() => setFailedSource(src)} />
      ) : <span role="img" aria-label={`${label} unavailable`}>{variant === "poster" ? "No poster" : "No backdrop"}</span>}
    </div>
  );
}

export function movieSummary(item: MoviePresentation): string {
  const year = item.year ?? item.metadataSnapshot?.year;
  const runtime = item.episode ? item.episode.runtimeMinutes : item.metadataSnapshot?.runtimeMinutes;
  return [item.episode?.airDate ?? year ?? "Year unavailable", runtime ? `${runtime} min${!item.episode && item.metadataSnapshot?.kind === "series" ? " typical episode" : ""}` : "Runtime unavailable"].join(" · ");
}

export function MovieDetails({ item }: { item: MoviePresentation & { title: string } }) {
  const snapshot = item.metadataSnapshot;
  return (
    <section className="tantalar-movie-details" aria-label={`${item.title} details`}>
      <MediaArtwork src={item.backdropUrl} title={item.title} variant="backdrop" />
      {item.episode ? <p><strong>{item.episode.episodeKey} · {item.episode.title}</strong></p> : null}
      <p>{movieSummary(item)}{snapshot?.certification ? ` · ${snapshot.certification}` : ""}</p>
      {snapshot?.tagline ? <p>{snapshot.tagline}</p> : null}
      <p>{(item.episode?.overview ?? item.overview ?? snapshot?.overview) || "Overview unavailable."}</p>
      <dl>
        <dt>Genres</dt><dd>{snapshot?.genres.length ? snapshot.genres.join(", ") : "Unavailable"}</dd>
        <dt>{snapshot?.kind === "series" ? "First aired" : "Release date"}</dt><dd>{snapshot?.releaseDate ?? "Unavailable"}</dd>
        {snapshot?.kind === "series" ? <><dt>Last aired</dt><dd>{snapshot.lastAirDate ?? "Unavailable"}</dd></> : null}
        <dt>Status</dt><dd><span className="tantalar-metadata-tag">{metadataLabel("state", snapshot?.status ?? "Unavailable")}</span></dd>
        <dt>Rating</dt><dd>{snapshot?.rating != null && snapshot.voteCount > 0 ? `${snapshot.rating.toFixed(1)}/10 (${snapshot.voteCount.toLocaleString()} votes)` : "Unavailable"}</dd>
      </dl>
    </section>
  );
}

const mediaLabels = { year: "Year", rating: "Rating", certification: "Certificate", actors: "Actor", directors: "Director", genres: "Genre", qualityProfile: "Quality" };
export function mediaLabelFilters(facets?: Record<string, string[]>) {
  return Object.entries(mediaLabels).map(([id, label]) => ({ id, label, options: (facets?.[id] ?? []).map(value => ({ value, label: value })) }));
}
export function mediaLabelColumns<T extends MoviePresentation>(): ColumnDef<T, unknown>[] {
  return [
    { id: "year", header: "Year", accessorFn: item => item.year ?? item.metadataSnapshot?.year, size: 85, meta: { labelFilter: true, compact: true } },
    { id: "rating", header: "Rating", accessorFn: item => item.metadataSnapshot?.rating != null && item.metadataSnapshot.voteCount > 0 ? item.metadataSnapshot.rating.toFixed(1) : null, size: 90, meta: { labelFilter: true } },
    { id: "certification", header: "Certificate", accessorFn: item => item.metadataSnapshot?.certification, size: 100, meta: { labelFilter: true } },
    { id: "actors", header: "Actor", accessorFn: item => item.metadataSnapshot?.actors ?? [], filterFn: "arrIncludes", enableSorting: false, size: 190, meta: { labelFilter: true, secondary: true } },
    { id: "directors", header: "Director", accessorFn: item => item.metadataSnapshot?.directors ?? [], filterFn: "arrIncludes", enableSorting: false, size: 170, meta: { labelFilter: true, secondary: true } },
    { id: "genres", header: "Genre", accessorFn: item => item.metadataSnapshot?.genres ?? [], filterFn: "arrIncludes", enableSorting: false, size: 150, meta: { labelFilter: true, secondary: true } },
    { id: "qualityProfile", header: "Quality", accessorFn: item => item.qualityProfile, size: 90, meta: { labelFilter: true, compact: true } },
  ];
}
