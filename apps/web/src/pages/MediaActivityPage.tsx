import { DenseGrid } from "../admin/DenseGrid";
import { ActionNotice } from "../components/ActionNotice";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Button,
  Group,
  Paper,
  Progress,
  Stack,
  Tabs,
  Text,
  Title,
} from "@mantine/core";
import { IconFilm, IconTv } from "symbols-react";
import { api, type WatchHistoryEntry } from "../api";
import { ErrorState, LoadState } from "./ProductPages";

type ActivitySection = "in-progress" | "history";

function safeArtworkUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value, window.location.origin);
    const isLibraryProxy =
      url.origin === window.location.origin &&
      url.pathname.startsWith("/api/v1/library/");
    const isTmdbImage = url.protocol === "https:" && url.hostname === "image.tmdb.org";
    return isLibraryProxy || isTmdbImage ? url.toString() : null;
  } catch {
    return null;
  }
}

function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return "0 sec";
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) return `${seconds} sec`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  return remaining > 0 ? `${hours} hr ${remaining} min` : `${hours} hr`;
}

function formatWatchedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Time unavailable";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function PosterThumbnail({ entry }: { readonly entry: WatchHistoryEntry }) {
  const [failed, setFailed] = useState(false);
  const artworkUrl = safeArtworkUrl(entry.artworkUrl);

  if (artworkUrl && !failed) {
    return (
      <img
        className="tantalar-activity-poster"
        data-testid={`activity-artwork-${entry.fileId}`}
        src={artworkUrl}
        alt=""
        aria-hidden="true"
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    );
  }

  const Icon = entry.kind === "series" ? IconTv : IconFilm;
  return (
    <div
      className="tantalar-activity-poster tantalar-activity-poster--fallback"
      data-testid={`activity-artwork-fallback-${entry.fileId}`}
      aria-hidden="true"
    >
      <Icon fill="currentColor" />
    </div>
  );
}

function ActivityList({ entries, emptyMessage, pendingFileId, onOpen }: {
  entries: readonly WatchHistoryEntry[]; emptyMessage: string; pendingFileId: string | null; onOpen: (entry: WatchHistoryEntry) => void;
}) {
  return <DenseGrid testId="watch-activity-grid" ariaLabel="watch activity" data={entries} defaultView="list" emptyMessage={emptyMessage} rowTestId={entry => `activity-row-${entry.fileId}`}
    artwork={entry => <PosterThumbnail entry={entry} />}
    filters={[{ id: "kind", label: "Types", options: [{ value: "movie", label: "Movie" }, { value: "series", label: "Series" }] }]}
    columns={[
      { id: "title", header: "Title", accessorKey: "title", size: 300 },
      { id: "kind", header: "Type", accessorKey: "kind", size: 100 },
      { id: "lastWatchedAt", header: "Watched", accessorKey: "lastWatchedAt", size: 160, cell: ({ row }) => formatWatchedAt(row.original.lastWatchedAt) },
      { id: "positionMs", header: "Progress", accessorKey: "positionMs", size: 230, cell: ({ row: { original: entry } }) => entry.completed ? "Watched" : entry.durationMs > 0 ? <div><Text size="xs">{formatDuration(entry.positionMs)} of {formatDuration(entry.durationMs)}</Text><Progress value={Math.min(100, entry.positionMs / entry.durationMs * 100)} aria-label={`${Math.round(entry.positionMs / entry.durationMs * 100)}% watched`} /></div> : "Progress saved" },
      { id: "actions", header: "Actions", enableHiding: false, size: 140, cell: ({ row: { original: entry } }) => <Button variant="light" loading={pendingFileId === entry.fileId} aria-label={`${entry.completed ? "Play again" : "Resume"} ${entry.title}`} onClick={() => onOpen(entry)}>{entry.completed ? "Play again" : "Resume"}</Button> },
    ]}
  />;
}

export function MediaActivityPage({ onWatch }: { readonly onWatch: (fileId: string) => void }) {
  const [section, setSection] = useState<ActivitySection>("in-progress");
  const [pendingFileId, setPendingFileId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ["watch-history"],
    queryFn: () => api.history(),
    retry: false,
  });

  if (query.isPending) return <LoadState label="Loading your activity…" />;
  if (query.isError) {
    return <ErrorState message={(query.error as Error).message} onRetry={() => void query.refetch()} />;
  }

  const inProgress = query.data.history.filter((entry) => !entry.completed);
  const completed = query.data.history.filter((entry) => entry.completed);

  const openEntry = (entry: WatchHistoryEntry) => {
    setActionError(null);
    if (!entry.completed) {
      onWatch(entry.fileId);
      return;
    }
    setPendingFileId(entry.fileId);
    void api
      .setResume(entry.fileId, 0, entry.durationMs, true)
      .then(() => onWatch(entry.fileId))
      .catch(() => setActionError(`Could not restart ${entry.title}. Please try again.`))
      .finally(() => setPendingFileId(null));
  };

  return (
    <Stack gap="lg" data-testid="activity-page">
      <header className="tantalar-page-heading">
        <Title order={1}>My activity</Title>
        <Text c="dimmed">Resume what you started or revisit something you finished.</Text>
      </header>

      {query.data.history.length === 0 ? (
        <Paper className="tantalar-activity-empty" p="xl">
          <Title order={2}>Nothing watched yet</Title>
          <Text c="dimmed" mt="xs">Start something from Home or your library.</Text>
        </Paper>
      ) : (
        <Tabs
          value={section}
          onChange={(value) => setSection(value === "history" ? "history" : "in-progress")}
          keepMounted={false}
        >
          <Tabs.List aria-label="Watch activity">
            <Tabs.Tab value="in-progress">In progress</Tabs.Tab>
            <Tabs.Tab value="history">History</Tabs.Tab>
          </Tabs.List>
          <ActionNotice message={actionError} title="Activity could not be updated" severity="error" />
          <Tabs.Panel value="in-progress" pt="sm">
            <ActivityList
              entries={inProgress}
              emptyMessage="Nothing to resume."
              pendingFileId={pendingFileId}
              onOpen={openEntry}
            />
          </Tabs.Panel>
          <Tabs.Panel value="history" pt="sm">
            <ActivityList
              entries={completed}
              emptyMessage="Nothing completed yet."
              pendingFileId={pendingFileId}
              onOpen={openEntry}
            />
          </Tabs.Panel>
        </Tabs>
      )}
    </Stack>
  );
}
