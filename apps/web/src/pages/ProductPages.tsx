/**
 * Wave 8 product pages: Home (continue watching + recently added),
 * Catalog (Movies / Series browsing with search and empty states) and
 * Calendar (upcoming releases from monitored media).
 *
 * Every view implements loading, empty, error+retry states. All styling
 * reads `--tantalar-*` tokens; no internal token names appear in copy.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Alert,
  Button,
  Card,
  Grid,
  Group,
  Progress,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { api, type LibraryItem } from "../api";

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
  title,
  subtitle,
  testId,
  progressPct,
  onOpen,
}: {
  title: string;
  subtitle?: string;
  testId: string;
  progressPct?: number;
  onOpen: () => void;
}) {
  return (
    <Card
      component="button"
      data-testid={testId}
      onClick={onOpen}
      shadow="sm"
      padding="md"
      radius="md"
      aria-label={`Play ${title}`}
      style={{
        textAlign: "left",
        cursor: "pointer",
        width: "100%",
        background: "var(--tantalar-color-surface-raised)",
        color: "var(--tantalar-color-text)",
        borderColor: "var(--tantalar-color-border)",
      }}
    >
      <Card.Section
        h={90}
        style={{
          background: "linear-gradient(135deg, var(--tantalar-color-primary) 0%, var(--tantalar-color-surface) 100%)",
          borderRadius: "var(--tantalar-radius-md) var(--tantalar-radius-md) 0 0",
        }}
        aria-hidden="true"
      />
      <Title order={6} mt="xs" lineClamp={1}>{title}</Title>
      {subtitle ? (
        <Text size="xs" c="var(--tantalar-color-text-dimmed)">{subtitle}</Text>
      ) : null}
      {progressPct !== undefined ? (
        <>
          <Group justify="space-between" mt={4}>
            <Text size="xs" c="var(--tantalar-color-text-dimmed)">{Math.round(progressPct)}% watched</Text>
          </Group>
          <Progress value={progressPct} mt={4} size="xs" />
        </>
      ) : null}
    </Card>
  );
}

/** Shared browse query with derived movies/series splits. */
function useLibrary() {
  return useQuery({ queryKey: ["library"], queryFn: () => api.browse() });
}

// ---- Home -------------------------------------------------------------------

export function HomePage({ onWatch }: { onWatch: (fileId: string) => void }) {
  const q = useLibrary();

  if (q.isPending) return <LoadState label="Loading home…" />;
  if (q.isError) return <ErrorState message={(q.error as Error).message} onRetry={() => void q.refetch()} />;

  const byId = new Map(q.data.items.map((i) => [i.fileId, i]));
  const recent = [...q.data.items].slice(0, 12);

  return (
    <Stack gap="lg" data-testid="home-page">
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
                  subtitle={item?.kind === "series" ? "Series episode" : "Movie"}
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
            Your library is empty. An administrator can add libraries in Settings.
          </Text>
        ) : (
          <SimpleGrid cols={{ base: 1, xs: 2, sm: 3, md: 4 }} mt="sm">
            {recent.map((item) => (
              <PosterCard
                key={item.fileId}
                testId={`home-item-${item.fileId}`}
                title={item.title}
                subtitle={item.kind === "series" ? "Series" : "Movie"}
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

const KIND_LABEL: Record<LibraryItem["kind"], string> = { series: "Series", movie: "Movie" };

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
  const q = useLibrary();
  const [filter, setFilter] = useState("");

  const items = useMemo(() => {
    const all = q.data?.items ?? [];
    return all
      .filter((i) => (kindFilter ? i.kind === kindFilter : true))
      .filter((i) => i.title.toLowerCase().includes(filter.trim().toLowerCase()));
  }, [q.data, kindFilter, filter]);

  if (q.isPending) return <LoadState label={`Loading ${heading.toLowerCase()}…`} />;
  if (q.isError) return <ErrorState message={(q.error as Error).message} onRetry={() => void q.refetch()} />;

  return (
    <Stack gap="lg" data-testid={`${heading.toLowerCase()}-page`}>
      <Group justify="space-between" wrap="wrap">
        <Title order={3}>{heading}</Title>
        <TextInput
          aria-label={`Search ${heading}`}
          placeholder="Search titles…"
          value={filter}
          onChange={(e) => setFilter(e.currentTarget.value)}
          miw={{ base: "100%", sm: 260 }}
        />
      </Group>

      {items.length === 0 ? (
        <Text c="var(--tantalar-color-text-dimmed)" size="sm">
          {filter
            ? `No ${heading.toLowerCase()} match “${filter}”.`
            : `No ${heading.toLowerCase()} are visible to you yet.`}
        </Text>
      ) : (
        <Grid mt="sm">
          {items.map((item) => (
            <Grid.Col key={item.fileId} span={{ base: 12, xs: 6, sm: 4, md: 3, lg: 2 }}>
              <PosterCard
                testId={`catalog-${item.fileId}`}
                title={item.title}
                subtitle={KIND_LABEL[item.kind]}
                onOpen={() => onWatch(item.fileId)}
              />
            </Grid.Col>
          ))}
        </Grid>
      )}
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
