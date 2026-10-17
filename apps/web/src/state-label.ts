/** Presentation only: provider state values remain unchanged for actions and filters. */
export function stateLabel(value: unknown): string {
  if (value == null || value === "") return "—";
  const words = String(value).trim().replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase();
  return words ? words[0]!.toUpperCase() + words.slice(1) : "—";
}

export function labelKind(field: string): "type" | "quality" | "state" | null {
  const key = field.replace(/[^a-z]/gi, "").toLowerCase();
  if (["kind", "type", "mediatype"].includes(key)) return "type";
  if (["quality", "qualityprofile"].includes(key)) return "quality";
  if (["state", "status", "acquisitionstate"].includes(key)) return "state";
  return null;
}

/** Display aliases only. Queries and actions continue to use the original value. */
export function metadataLabel(field: string, value: unknown): string {
  if (value == null || value === "") return "—";
  const text = String(value).trim();
  const key = text.toLowerCase().replace(/[\s_-]+/g, "");
  switch (labelKind(field)) {
    case "type": return ({ movie: "Movie", movies: "Movie", film: "Movie", films: "Movie", tv: "Series", tvshow: "Series", tvshows: "Series", television: "Series", show: "Series", series: "Series", episode: "Episode", mixed: "Mixed", nzb: "Usenet", usenet: "Usenet", torrent: "Torrent" } as Record<string, string>)[key] ?? stateLabel(text);
    case "quality": return ({ sd: "SD", hd: "HD", fullhd: "Full HD", fhd: "Full HD", uhd: "UHD", ultrahd: "UHD", "4k": "UHD", any: "Any quality", unknown: "Unknown" } as Record<string, string>)[key] ?? (/^(480|576|720|1080|1440|2160|4320)p?$/i.test(text) ? `${parseInt(text, 10)}p` : text);
    case "state": return stateLabel(text);
    default: return text;
  }
}
