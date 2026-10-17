/** Bound collection responses after provider authorization and enrichment. */
export function collectionPage<T>(items: readonly T[], query: Record<string, unknown>, fields: Record<string, (item: T) => unknown>) {
  const text = (value: unknown) => value == null ? "" : String(value).toLocaleLowerCase();
  const search = text(query.search).trim().slice(0, 300);
  const integer = (value: unknown, fallback: number, max: number) => {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
  };
  const pageSize = integer(query.pageSize, 25, 100);
  const page = integer(query.page, 1, 1_000_000);
  const filtered = items.filter(item => Object.entries(fields).every(([id, get]) => {
    const filter = query[`filter_${id}`];
    const value = get(item);
    return !filter || (Array.isArray(value) ? value.some(v => text(v) === text(filter)) : text(value) === text(filter));
  }) && (!search || Object.values(fields).some(get => text(get(item)).includes(search))));
  const sort = typeof query.sort === "string" && Object.hasOwn(fields, query.sort) ? fields[query.sort] : undefined;
  if (sort) filtered.sort((a, b) => {
    const av = sort(a), bv = sort(b);
    const result = typeof av === "number" && typeof bv === "number" ? av - bv : text(av).localeCompare(text(bv), undefined, { numeric: true });
    return query.desc === "true" ? -result : result;
  });
  return { items: filtered.slice((page - 1) * pageSize, page * pageSize), total: filtered.length };
}

export const mediaCollectionFields: Record<string, (item: Record<string, unknown>) => unknown> = {
  title: item => item.title,
  kind: item => item.kind,
  year: item => item.year,
  rating: item => {
    const snapshot = item.metadataSnapshot as Record<string, unknown> | undefined;
    return typeof snapshot?.rating === "number" && Number(snapshot.voteCount) > 0 ? snapshot.rating.toFixed(1) : null;
  },
  certification: item => (item.metadataSnapshot as Record<string, unknown> | undefined)?.certification,
  actors: item => (item.metadataSnapshot as Record<string, unknown> | undefined)?.actors,
  directors: item => (item.metadataSnapshot as Record<string, unknown> | undefined)?.directors,
  genres: item => (item.metadataSnapshot as Record<string, unknown> | undefined)?.genres,
  qualityProfile: item => item.qualityProfile,
};
export function collectionFacets<T>(items: readonly T[], fields: Record<string, (item: T) => unknown>) {
  return Object.fromEntries(Object.entries(fields).filter(([id]) => id !== "title").map(([id, get]) => [
    id, [...new Set(items.flatMap(item => {
      const value = get(item);
      return (Array.isArray(value) ? value : [value]).filter(v => v !== null && v !== undefined && v !== "").map(String);
    }))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
  ]));
}
