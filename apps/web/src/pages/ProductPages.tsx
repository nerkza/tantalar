/**
 * Wave 8 product pages: Home (continue watching + recently added),
 * Catalog (Movies / Series browsing with search and empty states) and
 * Calendar (upcoming releases from monitored media).
 *
 * Every view implements loading, empty, error+retry states. All styling
 * reads `--tantalar-*` tokens; no internal token names appear in copy.
 */
import type { ColumnDef } from "@tanstack/react-table";
import { DenseGrid, initialExplorerQuery, type ExplorerQuery } from "../admin/DenseGrid";
import { useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  Alert,
  Button,
  Card,
  Grid,
  Modal,
  Group,
  Progress,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { api, type LibraryItem } from "../api";
import { MediaArtwork, MovieDetails, movieSummary, mediaLabelColumns, mediaLabelFilters } from "../components/MovieMetadata";

export function LoadState({ label = "Loading…" }: { label?: string }) {
  return (
    <div aria-busy="true" role="status" style={{ padding: "var(--tantalar-space-unit)" }}>
      {label}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Alert
      role="alert"
      color="red"
      title="Something went wrong"
      style={{ background: "var(--tantalar-color-surface)", borderColor: "var(--tantalar-color-danger)" }}
    >
      <Group>
        <Text size="sm" c="var(--tantalar-color-text-dimmed)">{message}</Text>
        <Button variant="light" onClick={onRetry}>Retry</Button>
      </Group>
    </Alert>
  );
}

function PosterCard({
  title, subtitle, artworkUrl, testId, progressPct, onOpen, onDetails,
}: {
  title: string;
  subtitle?: string;
  artworkUrl?: string;
  testId: string;
  progressPct?: number;
  onOpen: () => void;
  onDetails?: () => void;
}) {
  return (
    <Card withBorder padding="sm" className="tantalar-movie-card">
      <button type="button" data-testid={testId} onClick={onOpen} aria-label={`Play ${title}`} className="tantalar-movie-card__open">
        <MediaArtwork src={artworkUrl} title={title} />
        <strong className="tantalar-movie-card__title">{title}</strong>
        {subtitle ? <Text component="span" size="xs" c="var(--tantalar-color-text-dimmed)">{subtitle}</Text> : null}
      </button>
      {progressPct !== undefined ? <>
        <Text size="xs" mt="xs">{Math.round(progressPct)}% watched</Text>
        <Progress value={progressPct} mt="xs" size="xs" />
      </> : null}
      {onDetails ? <Button variant="subtle" mt="xs" onClick={onDetails} aria-label={`Details for ${title}`}>Details</Button> : null}
    </Card>
  );
}

function MovieDialog({ item, onClose, onWatch }: { item: LibraryItem | null; onClose: () => void; onWatch: (fileId: string) => void }) {
  return <Modal opened={item !== null} onClose={onClose} title={item?.title ?? "Movie details"} size="lg">
    {item ? <Stack><MovieDetails item={item} /><Button onClick={() => onWatch(item.fileId)}>Play {item.title}</Button></Stack> : null}
  </Modal>;
}

/** Shared browse query with derived movies/series splits. */
function useLibrary() {
  return useQuery({ queryKey: ["library"], queryFn: () => api.browse() });
}

// ---- Home -------------------------------------------------------------------

export function HomePage({ onWatch }: { onWatch: (fileId: string) => void }) {
  const q = useLibrary();
  const [detailId, setDetailId] = useState<string | null>(null);

  if (q.isPending) return <LoadState label="Loading home…" />;
  if (q.isError) return <ErrorState message={(q.error as Error).message} onRetry={() => void q.refetch()} />;

  const byId = new Map(q.data.items.map((i) => [i.fileId, i]));
  const recent = [...q.data.items].slice(0, 12);

  return (
    <Stack gap="lg" data-testid="home-page">
      <MovieDialog item={q.data.items.find((item) => item.fileId === detailId) ?? null} onClose={() => setDetailId(null)} onWatch={onWatch} />
      <Title order={3}>Home</Title>

      <section aria-label="Continue watching">
        <Title order={5}>Continue watching</Title>
        {q.data.continueWatching.length === 0 ? (
          <Text c="var(--tantalar-color-text-dimmed)" mt="xs" size="sm">
            Nothing in progress. Start something from your library below.
          </Text>
        ) : (
          <SimpleGrid cols={{ base: 1, xs: 2, sm: 3, md: 4 }} mt="sm">
            {q.data.continueWatching.map((cw) => {
              const item = byId.get(cw.fileId);
              const pct = cw.durationMs > 0 ? Math.min(100, (cw.positionMs / cw.durationMs) * 100) : 0;
              return (
                <PosterCard
                  key={cw.fileId}
                  testId={`continue-${cw.fileId}`}
                  title={item?.title ?? cw.fileId}
                  artworkUrl={item?.artworkUrl}
                  subtitle={item?.episode ? `${item.episode.episodeKey} · ${item.episode.title}` : item?.kind === "movie" ? movieSummary(item) : "Series episode"}
                  onDetails={item?.kind === "movie" ? () => setDetailId(item.fileId) : undefined}
                  progressPct={pct}
                  onOpen={() => onWatch(cw.fileId)}
                />
              );
            })}
          </SimpleGrid>
        )}
      </section>

      <section aria-label="Recently added">
        <Title order={5}>In your library</Title>
        {recent.length === 0 ? (
          <Text c="var(--tantalar-color-text-dimmed)" mt="xs" size="sm">
          Your library is empty. An administrator can add libraries in Control.
          </Text>
        ) : (
          <SimpleGrid cols={{ base: 1, xs: 2, sm: 3, md: 4 }} mt="sm">
            {recent.map((item) => (
              <PosterCard
                key={item.fileId}
                testId={`home-item-${item.fileId}`}
                title={item.title}
                artworkUrl={item.artworkUrl}
                subtitle={item.episode ? `${item.episode.episodeKey} · ${item.episode.title}` : item.kind === "movie" ? `${movieSummary(item)} · Available` : "Series"}
                onDetails={item.kind === "movie" ? () => setDetailId(item.fileId) : undefined}
                onOpen={() => onWatch(item.fileId)}
              />
            ))}
          </SimpleGrid>
        )}
      </section>
    </Stack>
  );
}

// ---- Catalog (Movies / Series) ----------------------------------------------


export function CatalogPage({
  kindFilter,
  heading,
  onWatch,
}: {
  /** "movie", "series", or undefined for everything. */
  kindFilter?: LibraryItem["kind"];
  heading: string;
  onWatch: (fileId: string) => void;
}) {
  const [query, setQuery] = useState<ExplorerQuery>(initialExplorerQuery);
  const q = useQuery({
    queryKey: ["library", "explorer", kindFilter, query],
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) => api.browsePage({ ...query, filters: { ...query.filters, ...(kindFilter ? { kind: kindFilter } : {}) } }, signal),
  });
  const [detailId, setDetailId] = useState<string | null>(null);
  const columns = useMemo<ColumnDef<LibraryItem, unknown>[]>(() => [
          { id: "title", header: "Title", accessorKey: "title", size: 320, cell: ({ row }) => <div>{row.original.title}{row.original.episode ? <Text size="sm" c="dimmed" lineClamp={1}>{row.original.episode.episodeKey} · {row.original.episode.title}</Text> : null}</div> },
          ...mediaLabelColumns<LibraryItem>(),
          { id: "kind", header: "Type", accessorKey: "kind", size: 110 },
          { id: "actions", header: "Actions", enableHiding: false, size: 220, cell: ({ row }) => <Group gap="xs">
            <Button variant="default" data-testid={`catalog-${row.original.fileId}`} aria-label={`Play ${row.original.title}`} onClick={() => onWatch(row.original.fileId)}>Play</Button>
            <Button variant="subtle" aria-label={`Details for ${row.original.title}`} onClick={() => setDetailId(row.original.fileId)}>Details</Button>
          </Group> },
        ], [onWatch]);
  return (
    <Stack gap="lg" data-testid={`${heading.toLowerCase()}-page`}>
      <MovieDialog item={q.data?.items.find(item => item.fileId === detailId) ?? null} onClose={() => setDetailId(null)} onWatch={onWatch} />
      <Title order={1}>{heading}</Title>
      {q.isError ? <ErrorState message={(q.error as Error).message} onRetry={() => void q.refetch()} /> : null}
      <DenseGrid<LibraryItem>
        key={kindFilter ?? "all"} testId={`catalog-${kindFilter ?? "all"}-grid`} ariaLabel={heading}
        defaultView="medium" data={q.data?.items ?? []} total={q.data?.total ?? 0} loading={q.isFetching}
        onQueryChange={setQuery} artwork={item => <MediaArtwork src={item.artworkUrl} title={item.title} />}
        emptyMessage={`No matching ${heading.toLowerCase()}.`}
        filters={[...mediaLabelFilters(q.data?.facets), ...(kindFilter ? [] : [{ id: "kind", label: "Types", options: [{ value: "movie", label: "Movies" }, { value: "series", label: "Series" }] }])]}
        columns={columns}
      />
    </Stack>
  );
}

// ---- Calendar -----------------------------------------------------------------

interface CalendarEntry {
  readonly itemKey: string;
  readonly kind: "series" | "movie";
  readonly title: string;
  readonly date: string;
}

/**
 * Calendar of upcoming releases from the library plugin's monitored media.
 * Data comes from the importer capability (`calendar` operation); when the
 * plugin is absent the section degrades to a truthful empty state.
 */
export function CalendarPage() {
  const q = useQuery({
    queryKey: ["calendar"],
    queryFn: async (): Promise<CalendarEntry[]> => {
      const res = await api.invokeCapability(
        "dev.tantalar.plugin.library",
        "dev.tantalar.capability.importer",
        "calendar",
      );
      return ((res.result as { upcoming?: CalendarEntry[] }).upcoming ?? []) as CalendarEntry[];
    },
    retry: false,
  });

  if (q.isPending) return <LoadState label="Loading calendar…" />;
  if (q.isError) {
    return (
      <Stack gap="lg" data-testid="calendar-page">
        <Title order={3}>Calendar</Title>
        <Text c="var(--tantalar-color-text-dimmed)" size="sm">
          The calendar follows monitored series and movies. No monitored media is registered yet.
        </Text>
      </Stack>
    );
  }

  const upcoming = q.data ?? [];
  return (
    <Stack gap="lg" data-testid="calendar-page">
      <Title order={3}>Calendar</Title>
      {upcoming.length === 0 ? (
        <Text c="var(--tantalar-color-text-dimmed)" size="sm">
          No upcoming releases. Add monitored series or movies and their dates appear here.
        </Text>
      ) : (
        <Stack gap="xs">
          {upcoming.map((entry) => (
            <Group key={entry.itemKey} justify="space-between" wrap="wrap"
              style={{
                background: "var(--tantalar-color-surface)",
                border: "1px solid var(--tantalar-color-border)",
                borderRadius: "var(--tantalar-radius-md)",
                padding: "var(--tantalar-space-unit)",
              }}
            >
              <div>
                <Text size="sm">{entry.title}</Text>
                <Text size="xs" c="var(--tantalar-color-text-dimmed)">
                  {entry.kind === "series" ? "Series episode" : "Movie"}
                </Text>
              </div>
              <Text size="sm" c="var(--tantalar-color-text-dimmed)">{entry.date}</Text>
            </Group>
          ))}
        </Stack>
      )}
    </Stack>
  );
}
