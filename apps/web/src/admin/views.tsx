/**
 * Admin views (phase 6, stories 25–27): queue, wanted, history, plugins,
 * users, settings/theme editor and system health. Every view implements the
 * full state set: loading, empty, error+retry, permission-denied and
 * degraded-service handling. All styling reads `--tantalar-*` tokens.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useDebouncedValue, useMediaQuery } from "@mantine/hooks";
import type { ColumnDef } from "@tanstack/react-table";
import {
  Alert,
  Box,
  Button,
  Drawer,
  Group,
  Modal,
  NativeSelect,
  Paper,
  PasswordInput,
  Stack,
  Switch,
  Tabs,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { api, type DownloadJob, type AuditEntry, type TrajectoryEvent, type WantedLedgerItem } from "../api";
import { formatDateTime, formatShortDate } from "../date";
import { useLiveEventFeed, type LiveFeedStatus } from "../live-event-feed";
import { DenseGrid, initialExplorerQuery, type GridLayout } from "./DenseGrid";
import { MediaArtwork } from "../components/MovieMetadata";
import { stateLabel } from "../state-label";
import { DownloadProgress, downloadRate } from "./DownloadProgress";
import { useTheme } from "../theme/engine";
import { DEFAULT_TOKENS, TOKEN_PREFIX, TOKEN_LABELS, sanitizeTokenOverrides } from "../theme/tokens";
import { assembleChains, reconstructDecision, type DecisionNarrative } from "../activity/trajectory";
import "./audit.css";
import { ActionNotice, useActionFeedback } from "../components/ActionNotice";
import { UsersView } from "./PeoplePage";

// ---- Shared state wrappers -------------------------------------------------

function LoadState() {
  return (
    <div aria-busy="true" role="status" style={{ padding: "var(--tantalar-space-unit)" }}>
      Loading…
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
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

function PermissionState() {
  return (
    <Alert role="alert" title="Admin access required" color="yellow">
      <Text size="sm">This view needs an administrator account.</Text>
    </Alert>
  );
}

function useAdminQuery<T>(key: readonly unknown[], fn: () => Promise<T>) {
  return useQuery({ queryKey: key, queryFn: fn, retry: false });
}

// ---- Queue view (Wave 9, TAN-030: durable jobs + full actions) --------------

export function QueueView({ adminId }: { adminId: string | null }) {
  const qc = useQueryClient();
  const [showHistory, setShowHistory] = useState(false);
  const [queueQuery, setQueueQuery] = useState(initialExplorerQuery);
  const samples = useRef(new Map<string, { job: DownloadJob; rate: number | null; observedAt: number }>());
  const [note, setNote, noteSeverity, noteRevision] = useActionFeedback();
  const [removeTarget, setRemoveTarget] = useState<DownloadJob | null>(null);
  const [removing, setRemoving] = useState(false);
  const q = useQuery({ queryKey: ["admin", "queue", showHistory, queueQuery], queryFn: async () => {
    const response = await api.queue(showHistory, queueQuery);
    const next = new Map(response.jobs.map(job => {
      const previous = samples.current.get(job.jobId);
      const unchanged = previous?.job.updatedAt === job.updatedAt;
      const rate = unchanged && Date.now() - previous.observedAt <= 10_000 ? previous.rate : downloadRate(previous?.job, job);
      return [job.jobId, { job, rate, observedAt: unchanged ? previous.observedAt : Date.now() }];
    }));
    const rates = Object.fromEntries([...next].map(([id, sample]) => [id, sample.rate]));
    samples.current = next;
    return { ...response, rates };
  }, retry: false, refetchInterval: 2_000, placeholderData: previous => previous });

  const act = async (
    job: DownloadJob,
    action: "pause" | "resume" | "retry" | "remove",
  ) => {
    setNote(null);
    if (action === "remove") {
      setRemoveTarget(job);
      return;
    }
    try {
      await api.queueAction(job.jobId, action);
    } catch (err) {
      setNote((err as Error).message, "error");
    }
    void qc.invalidateQueries({ queryKey: ["admin", "queue"] });
  };

  const remove = async (deleteDataFiles: boolean) => {
    if (!removeTarget) return;
    setRemoving(true);
    setNote(null);
    try {
      const res = await api.queueAction(removeTarget.jobId, "remove", { deleteDataFiles });
      setNote(res.note ?? "Removed.");
      setRemoveTarget(null);
      void qc.invalidateQueries({ queryKey: ["admin", "queue"] });
    } catch (err) {
      setNote((err as Error).message, "error");
    } finally {
      setRemoving(false);
    }
  };

  if (q.isPending) return <LoadState />;
  if (q.isError) return <ErrorState message={(q.error as Error).message} onRetry={() => void q.refetch()} />;

  const jobs = q.data.jobs;
  const columns: ReadonlyArray<ColumnDef<DownloadJob, unknown>> = [
    { id: "title", header: "Title", accessorFn: r => r.media?.title ?? r.title, cell: ({ row }) => <div><Text size="sm" fw={600}>{row.original.media?.title ?? row.original.title}</Text>{row.original.media ? <Text size="xs" c="dimmed">{[row.original.media.year, stateLabel(row.original.media.kind), row.original.media.episode].filter(Boolean).join(" · ")}</Text> : null}</div> },
    { id: "source", header: "Engine", accessorFn: r => r.source, cell: ({ row }) => row.original.source === "usenet" ? "Usenet" : "Torrent", meta: { secondary: true } },
    { id: "state", header: "Status", accessorFn: r => r.status ?? r.state, meta: { compact: true }, cell: ({ row }) => stateLabel(row.original.status ?? row.original.state) },
    { id: "progressPercent", header: "Progress", accessorKey: "progressPercent", meta: { dataType: "number", compact: true }, cell: ({ row }) => <DownloadProgress job={row.original} bytesPerSecond={q.data.rates[row.original.jobId] ?? null} /> },
    { id: "release", header: "Release", accessorFn: r => r.media && r.media.title !== r.title ? r.title : "", meta: { secondary: true } },
    { id: "priority", header: "Priority", accessorKey: "priority", meta: { dataType: "number", secondary: true } },
    { id: "retryCount", header: "Retries", accessorKey: "retryCount", meta: { dataType: "number", secondary: true } },
    {
      id: "failure",
      header: "Failure detail",
      meta: { secondary: true },
      accessorFn: (r) => r.failureReason ?? "",
      cell: ({ row }) =>
        row.original.failureReason ? (
          <Text size="xs" c="var(--tantalar-color-danger)">{row.original.failureReason}</Text>
        ) : null,
    },
    {
      id: "handoff",
      header: "Import handoff",
      meta: { secondary: true },
      accessorFn: (r) => r.importHandoffPath ?? "",
      cell: ({ row }) =>
        row.original.importHandoffPath ? (
          <Text size="xs">Imported</Text>
        ) : null,
    },
    {
      id: "actions",
      header: "Actions",
      enableSorting: false,
      cell: ({ row }) => {
        const j = row.original;
        return (
          <Group gap="xs">
            {j.state === "downloading" ? (
              <Button size="compact-xs" variant="default" data-testid={`pause-${j.jobId}`} onClick={() => void act(j, "pause")}>
                Pause
              </Button>
            ) : null}
            {j.state === "paused" ? (
              <Button size="compact-xs" variant="default" data-testid={`resume-${j.jobId}`} onClick={() => void act(j, "resume")}>
                Resume
              </Button>
            ) : null}
            {j.state === "failed" ? (
              <Button size="compact-xs" variant="default" data-testid={`retry-${j.jobId}`} onClick={() => void act(j, "retry")}>
                Retry
              </Button>
            ) : null}
            {!j.removed && j.state !== "completed" ? (
              <Button size="compact-xs" variant="light" color="red" data-testid={`remove-${j.jobId}`} onClick={() => void act(j, "remove")}>
                Remove
              </Button>
            ) : null}
          </Group>
        );
      },
    },
  ];

  return (
    <Stack gap="sm">
      <Group justify="space-between">
        <Title order={4}>Queue</Title>
        <Switch
          label="Show history"
          aria-label="Show download history"
          checked={showHistory}
          onChange={(e) => setShowHistory(e.currentTarget.checked)}
        />
      </Group>
      <ActionNotice message={note} title="Downloads" severity={noteSeverity} revision={noteRevision} />
      <Modal
        opened={removeTarget !== null}
        onClose={() => setRemoveTarget(null)}
        title="Remove download"
        centered
      >
        <Stack gap="md">
          <Text size="sm">Remove “{removeTarget?.title}” from the queue?</Text>
          <Group justify="flex-end">
            <Button variant="default" disabled={removing} onClick={() => setRemoveTarget(null)}>Cancel</Button>
            <Button variant="default" loading={removing} onClick={() => void remove(false)}>Keep downloaded files</Button>
            <Button color="red" loading={removing} onClick={() => void remove(true)}>Delete downloaded files</Button>
          </Group>
        </Stack>
      </Modal>
      <DenseGrid
        testId="queue-grid"
        artwork={job => <MediaArtwork src={job.media?.artworkUrl} title={job.media?.title ?? job.title} />}
        onQueryChange={setQueueQuery}
        total={q.data.total ?? jobs.length}
        filters={["state", "source"].map(id => ({ id, label: id === "state" ? "Status" : "Sources", options: (q.data.facets?.[id] ?? [...new Set(jobs.map(job => id === "state" ? job.status ?? job.state : job.source))]).sort().map(value => ({ value, label: stateLabel(value) })) }))}
        columns={columns}
        data={jobs}
        emptyMessage={showHistory ? "No downloads yet." : "The download queue is empty."}
      />
    </Stack>
  );
}

// ---- Wanted view ------------------------------------------------------------

export function WantedView({
  adminId,
  onSearchReleases,
}: {
  adminId: string | null;
  onSearchReleases?: (item: WantedLedgerItem) => void;
}) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote, noteSeverity, noteRevision] = useActionFeedback();
  const q = useAdminQuery(["admin", "wanted"], api.wanted);

  const recover = async (item: WantedLedgerItem) => {
    const recovery = item.recovery;
    if (!recovery) return;
    if (recovery.action === "search") {
      onSearchReleases?.(item);
      return;
    }
    if (!recovery.jobId) return;
    setBusy(item.itemKey);
    setNote(null);
    try {
      await api.queueAction(recovery.jobId, recovery.action);
    } catch (error) {
      setNote((error as Error).message, "error");
    } finally {
      setBusy(null);
      void Promise.all([
        qc.invalidateQueries({ queryKey: ["admin", "wanted"] }),
        qc.invalidateQueries({ queryKey: ["admin", "queue"] }),
      ]);
    }
  };

  if (q.isPending) return <LoadState />;
  if (q.isError) return <ErrorState message={(q.error as Error).message} onRetry={() => void q.refetch()} />;

  const columns: ReadonlyArray<ColumnDef<WantedLedgerItem, unknown>> = [
    { id: "title", header: "Item", accessorKey: "title" },
    {
      id: "kind",
      header: "Type",
      accessorFn: (item) => item.kind === "movie" ? "Movie" : `Series · ${item.episodeKey ?? "Episode"}`,
    },
    { id: "state", header: "State", accessorKey: "state" },
    {
      id: "failureDetail",
      header: "Failure detail",
      accessorFn: (item) => item.failureDetail ?? "",
      cell: ({ row }) => row.original.failureDetail
        ? <Text size="xs" c="var(--tantalar-color-danger)">{row.original.failureDetail}</Text>
        : null,
    },
    {
      id: "recovery",
      header: "Next action",
      enableSorting: false,
      cell: ({ row }) => row.original.recovery ? (
        <Button
          size="compact-xs"
          variant="default"
          loading={busy === row.original.itemKey}
          onClick={() => void recover(row.original)}
        >
          {row.original.recovery.label}
        </Button>
      ) : null,
    },
  ];

  return (
    <Stack gap="sm">
      <Title order={4}>Wanted</Title>
      <ActionNotice message={note} title="Wanted media" severity="error" revision={noteRevision} />
      <DenseGrid
        testId="wanted-grid"
        columns={columns}
        data={q.data.items}
        emptyMessage="Nothing is missing — everything monitored is acquired."
      />
    </Stack>
  );
}

// ---- History view -----------------------------------------------------------

export function HistoryView({ adminId }: { adminId: string | null }) {
  const q = useAdminQuery(["admin", "history"], () => api.history());

  if (q.isPending) return <LoadState />;
  if (q.isError) return <ErrorState message={(q.error as Error).message} onRetry={() => void q.refetch()} />;

  const rows: Record<string, unknown>[] = (q.data.history ?? []).map(entry => ({ ...entry }));
  const columns: ReadonlyArray<ColumnDef<Record<string, unknown>, unknown>> = [
    { id: "userId", header: "Viewer", accessorFn: (r) => String(r.userId ?? "") },
    { id: "fileId", header: "File", accessorFn: (r) => String(r.fileId ?? "") },
    { id: "completed", header: "Completed", accessorFn: (r) => String(r.completed ?? "") },
    {
      id: "startedAt",
      header: "Started",
      accessorFn: (r) => String(r.startedAt ?? ""),
      cell: ({ row }) => formatDateTime(String(row.original.startedAt ?? "")),
      meta: { dataType: "time" },
    },
  ];

  return (
    <Stack gap="sm">
      <Title order={4}>Watch history</Title>
      <DenseGrid
        testId="history-grid"
        columns={columns}
        data={rows}
        emptyMessage="No watch history yet."
      />
    </Stack>
  );
}

// ---- Plugins view (Wave 9, TAN-031: full management) ------------------------

function pluginDisplayName(id: string): string {
  const slug = id.split(".plugin.").at(-1) ?? id;
  const names: Record<string, string> = {
    "indexer-torznab-newznab": "Torznab & Newznab Indexers",
    "metadata-tmdb-tvdb": "TMDB & TVDB Metadata",
    "torrent-native": "Native Torrent",
    "usenet-native": "Native Usenet",
    serving: "Media Serving",
  };
  if (names[slug]) return names[slug];
  const acronyms: Record<string, string> = { mcp: "MCP", nntp: "NNTP", sabnzbd: "SABnzbd", tmdb: "TMDB", tvdb: "TVDB", vpn: "VPN" };
  return slug
    .split("-")
    .map((word) => acronyms[word] ?? `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

export function PluginsView() {
  const qc = useQueryClient();
  const q = useAdminQuery(["admin", "plugins"], () => api.plugins());
  const [note, setNote, noteSeverity, noteRevision] = useActionFeedback();

  const act = async (id: string, action: "restart" | "disable") => {
    setNote(null);
    if (action === "disable") {
      // Service impact is explained BEFORE the irreversible action.
      try {
        const detail = await api.pluginDetail(id);
        const proceed = window.confirm(
          detail.serviceImpact
            ? `Disable ${id}?\n\n${detail.serviceImpact}`
            : `Disable ${id}? Its capabilities become unavailable until re-enabled.`,
        );
        if (!proceed) return;
      } catch {
        /* fall through to the disable attempt */
      }
    }
    try {
      const res = await api.pluginAction(id, action);
      setNote(res.impact ?? `${action} completed for ${id}.`);
    } catch (err) {
      setNote(`${id}: ${(err as Error).message}`, "error");
    }
    void qc.invalidateQueries({ queryKey: ["admin", "plugins"] });
  };

  if (q.isPending) return <LoadState />;
  if (q.isError) return <ErrorState message={(q.error as Error).message} onRetry={() => void q.refetch()} />;

  return (
    <Stack gap="sm">
      <Group justify="space-between" align="flex-start" wrap="wrap">
        <div>
          <Title order={4}>Installed extensions</Title>
          <Text size="sm" c="var(--tantalar-color-text-dimmed)">
            First-party and community extensions use the same public plugin contract.
          </Text>
        </div>
        <Button
          variant="default"
          disabled
          title="Plugin package verification and installation are not available yet."
        >
          Import plugin
        </Button>
      </Group>
      <Text size="xs" c="var(--tantalar-color-text-dimmed)">
        Local archive import and a community directory are planned. Import stays disabled until packages can be verified and installed safely.
      </Text>
      <ActionNotice message={note} title="Plugins" severity={noteSeverity} revision={noteRevision} />
      <DenseGrid testId="plugins-grid" ariaLabel="plugins" data={q.data.plugins} defaultView="list" rowTestId={p => `plugin-${p.manifest.id}`}
        filters={[{ id: "state", label: "States", options: [...new Set(q.data.plugins.map(p => p.state))].map(value => ({ value, label: value })) }]}
        columns={[
          { id: "name", header: "Name", accessorFn: p => pluginDisplayName(p.manifest.id), size: 250 },
          { id: "id", header: "ID", accessorFn: p => p.manifest.id, size: 300 },
          { id: "version", header: "Version", accessorFn: p => p.manifest.version, size: 100 },
          { id: "state", header: "State", accessorKey: "state", size: 100 },
          { id: "restartCount", header: "Restarts", accessorKey: "restartCount", size: 90, meta: { dataType: "number" } },
          { id: "actions", header: "Actions", enableHiding: false, size: 210, cell: ({ row: { original: p } }) => <Group gap="xs"><Button size="compact-xs" variant="default" data-testid={`restart-${p.manifest.id}`} onClick={() => void act(p.manifest.id, "restart")}>Restart</Button><Button size="compact-xs" variant="light" color="red" data-testid={`disable-${p.manifest.id}`} onClick={() => void act(p.manifest.id, "disable")}>Disable</Button></Group> },
        ]}
      />
    </Stack>
  );
}

// ---- Users view (Wave 9, TAN-032: full management + last-admin safeguard) ----

export { UsersView };

// ---- Audit view (Wave 9, TAN-032: unified operations log) --------------------

export const OPERATIONS_LOG_CATEGORIES = [
  "Access",
  "Extensions",
  "Acquisition",
  "Media",
  "Playback",
  "Automation",
  "System",
  "Other",
] as const;

export type OperationsLogCategory = (typeof OPERATIONS_LOG_CATEGORIES)[number];

export const OPERATIONS_LOG_CATEGORY_COLORS: Readonly<Record<OperationsLogCategory, string>> = {
  Access: "violet",
  Extensions: "grape",
  Acquisition: "orange",
  Media: "cyan",
  Playback: "blue",
  Automation: "teal",
  System: "gray",
  Other: "indigo",
};

const CATEGORY_PREFIXES: ReadonlyArray<readonly [OperationsLogCategory, readonly string[]]> = [
  ["Access", ["user", "apikey", "auth"]],
  ["Extensions", ["plugin", "capability"]],
  ["Acquisition", ["acquisition", "queue", "download", "grab", "release", "indexer", "blacklist", "comparison", "tunnel", "client.dispatch"]],
  ["Media", ["library", "import", "media", "metadata", "movie", "series"]],
  ["Playback", ["playback", "transcode"]],
  ["Automation", ["scheduler", "webhook", "mcp"]],
  ["System", ["system", "server", "client.incident", "upgrade"]],
];

export function classifyOperationsLogAction(action: string): OperationsLogCategory {
  const normalized = action.replace(/^dev\.tantalar\.event\./, "").toLowerCase();
  for (const [category, prefixes] of CATEGORY_PREFIXES) {
    if (prefixes.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}.`))) return category;
  }
  return "Other";
}

export interface OperationsLogEntry {
  readonly id: string;
  readonly category: OperationsLogCategory;
  readonly source: "Audit" | "Event";
  readonly occurredAt: string;
  readonly actor: string;
  readonly action: string;
  readonly target: string;
  readonly detail: Record<string, unknown>;
  readonly correlationId?: string;
  readonly causationId?: string;
}

const AUDIT_LAYOUT_KEY = "tantalar.audit-grid.layout.v2";
const TRACE_LAYOUT_KEY = "tantalar.trace-grid.layout.v1";
const DEFAULT_AUDIT_LAYOUT: GridLayout = {
  hiddenColumns: ["trace"],
  density: "dense",
  columnOrder: ["occurredAt", "category", "source", "actor", "action", "target", "trace"],
  columnWidths: {
    occurredAt: 150,
    category: 100,
    source: 72,
    actor: 135,
    action: 210,
    target: 165,
    trace: 180,
  },
  sorting: [{ id: "occurredAt", desc: true }],
};
const DEFAULT_TRACE_LAYOUT: GridLayout = {
  hiddenColumns: ["source", "trace"],
  density: "dense",
  columnOrder: ["occurredAt", "category", "action", "target", "source", "trace"],
  columnWidths: {
    occurredAt: 150,
    category: 100,
    action: 250,
    target: 180,
    source: 90,
    trace: 180,
  },
  sorting: [{ id: "occurredAt", desc: true }],
};

function loadGridLayout(key: string, fallback: GridLayout): GridLayout {
  try {
    const stored = window.localStorage.getItem(key);
    return stored ? { ...fallback, ...JSON.parse(stored) as GridLayout } : fallback;
  } catch {
    return fallback;
  }
}

function saveGridLayout(key: string, layout: GridLayout): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(layout));
  } catch {
    // The layout remains usable for this session when storage is unavailable.
  }
}

function eventLogEntry(event: TrajectoryEvent): OperationsLogEntry {
  return {
    id: `event:${event.eventId}`,
    category: classifyOperationsLogAction(event.type),
    source: "Event",
    occurredAt: event.occurredAt,
    actor: event.producer,
    action: event.type,
    target: event.subject ?? "—",
    detail: event.payload,
    correlationId: event.correlationId,
    causationId: event.causationId,
  };
}

type TimelineWindowMinutes = 5 | 15 | 30 | 360 | 1_440;

function AuditActivityMap({
  entries,
  selectedId,
  onSelect,
  windowMinutes,
  onWindowMinutesChange,
  liveStatus,
}: {
  readonly entries: readonly OperationsLogEntry[];
  readonly selectedId?: string;
  readonly onSelect: (entry: OperationsLogEntry) => void;
  readonly windowMinutes: TimelineWindowMinutes;
  readonly onWindowMinutesChange: (minutes: TimelineWindowMinutes) => void;
  readonly liveStatus: LiveFeedStatus;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const windowStart = now - windowMinutes * 60_000;
  const duration = Math.max(1_000, now - windowStart);
  const visibleEntries = entries.filter((entry) => {
    const occurredAt = Date.parse(entry.occurredAt);
    return Number.isFinite(occurredAt) && occurredAt >= windowStart && occurredAt <= now;
  });
  const byCategory = OPERATIONS_LOG_CATEGORIES.map((category) => ({
    category,
    entries: visibleEntries.filter((entry) => entry.category === category),
  })).filter((lane) => lane.entries.length > 0);
  return (
    <section
      className="tantalar-activity-map"
      aria-label="Activity timeline"
      data-testid="audit-activity-map"
      data-live={liveStatus === "live" || undefined}
    >
      <Group justify="space-between" gap="xs" mb="xs">
        <Group gap="xs">
          <Text fw={600}>Timeline</Text>
          <span
            className="tantalar-activity-map__connection"
            data-state={liveStatus}
            role="status"
            aria-label={`Timeline connection: ${liveStatus}`}
          >
            {liveStatus === "live"
              ? null
              : liveStatus === "unavailable"
                ? "Unavailable"
                : liveStatus === "connecting"
                  ? "Connecting…"
                  : "Feed disconnected. Retrying…"}
          </span>
        </Group>
        <Group gap="xs">
          <Text size="xs" c="dimmed" className="tantalar-tabular">{visibleEntries.length} events</Text>
          <NativeSelect
            aria-label="Activity window"
            value={String(windowMinutes)}
            onChange={(event) => onWindowMinutesChange(Number(event.currentTarget.value) as TimelineWindowMinutes)}
            data={[
              { value: "5", label: "5 min" },
              { value: "15", label: "15 min" },
              { value: "30", label: "30 min" },
              { value: "360", label: "6 hr" },
              { value: "1440", label: "24 hr" },
            ]}
            size="xs"
          />
        </Group>
      </Group>
      {byCategory.length === 0 ? (
        <div className="tantalar-activity-map__empty">No activity in this window</div>
      ) : (
        <div className="tantalar-activity-map__lanes">
          {byCategory.map((lane) => (
            <div className="tantalar-activity-map__lane" key={lane.category}>
              <span>{lane.category}</span>
              <div>
                {lane.entries.map((entry) => {
                  const color = OPERATIONS_LOG_CATEGORY_COLORS[entry.category];
                  const left = Math.max(0, Math.min(100, ((Date.parse(entry.occurredAt) - windowStart) / duration) * 100));
                  return (
                    <button
                      type="button"
                      key={entry.id}
                      className="tantalar-activity-map__event"
                      data-selected={selectedId === entry.id || undefined}
                      style={{ backgroundColor: `var(--mantine-color-${color}-6)`, left: `${left}%` }}
                      aria-label={`${entry.category}: ${entry.action} at ${formatDateTime(entry.occurredAt)}`}
                      title={`${entry.action}\n${formatDateTime(entry.occurredAt)}`}
                      onClick={() => onSelect(entry)}
                    />
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="tantalar-activity-map__axis" aria-hidden="true">
        <span>{new Date(windowStart).toLocaleTimeString()}</span>
        <span>now</span>
      </div>
    </section>
  );
}

function mergeOperationsLog(
  auditEntries: readonly AuditEntry[],
  events: readonly TrajectoryEvent[],
): OperationsLogEntry[] {
  return [
    ...auditEntries.map((entry) => ({
      id: `audit:${entry.id}`,
      category: classifyOperationsLogAction(entry.action),
      source: "Audit" as const,
      occurredAt: entry.occurredAt,
      actor: entry.actorUsername ?? "system",
      action: entry.action,
      target: `${entry.targetType}:${entry.targetId}`,
      detail: entry.detail,
    })),
    ...events.map((event) => ({
      id: `event:${event.eventId}`,
      category: classifyOperationsLogAction(event.type),
      source: "Event" as const,
      occurredAt: event.occurredAt,
      actor: event.producer,
      action: event.type,
      target: event.subject ?? "—",
      detail: event.payload,
      correlationId: event.correlationId,
      causationId: event.causationId,
    })),
  ].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
}

function mergeTimelineEntries(
  snapshot: readonly OperationsLogEntry[],
  streamed: readonly OperationsLogEntry[],
): OperationsLogEntry[] {
  const byId = new Map(snapshot.map((entry) => [entry.id, entry]));
  for (const entry of streamed) byId.set(entry.id, entry);
  return [...byId.values()].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
}

export function downloadAuditLog(entries: readonly OperationsLogEntry[]): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(entries, null, 2)], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `tantalar-operations-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function OperationsLogInspector({
  entry,
  onClose,
  narrative,
}: {
  readonly entry: OperationsLogEntry;
  readonly onClose: () => void;
  readonly narrative?: DecisionNarrative | null;
}) {
  return (
    <section
      role="region"
      aria-label="Selected audit record"
      className="tantalar-audit-inspector"
      data-testid="operations-log-inspector"
    >
      <Group className="tantalar-audit-inspector__header" justify="space-between" align="flex-start" mb="sm" wrap="nowrap">
        <div>
          <Title order={5} lineClamp={2}>{entry.action}</Title>
        </div>
        <Button size="compact-xs" variant="subtle" onClick={onClose}>Close</Button>
      </Group>
      <Tabs key={entry.id} defaultValue="summary" keepMounted={false}>
        <Tabs.List aria-label="Selected record details">
          <Tabs.Tab value="summary">Summary</Tabs.Tab>
          {narrative ? <Tabs.Tab value="trace">Trace</Tabs.Tab> : null}
          <Tabs.Tab value="raw">Raw</Tabs.Tab>
          <Tabs.Tab value="links">Links</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="summary" pt="sm">
          <Stack gap={4}>
            <Text size="sm"><strong>Category:</strong> {entry.category}</Text>
            <Text size="sm"><strong>Source:</strong> {entry.source}</Text>
            <Text size="sm"><strong>Recorded:</strong> {formatDateTime(entry.occurredAt)}</Text>
            <Text size="sm"><strong>Actor / producer:</strong> {entry.actor}</Text>
            <Text size="sm"><strong>Target / subject:</strong> {entry.target}</Text>
          </Stack>
        </Tabs.Panel>
        {narrative ? (
          <Tabs.Panel value="trace" pt="sm">
            <Stack gap="sm">
              <Text size="sm">{narrative.summary}</Text>
              <Stack component="ol" gap="xs" m={0} pl="md">
                {narrative.steps.map((step) => (
                  <Box component="li" key={step.id}>
                    <Text size="sm" fw={600}>{step.label}</Text>
                    <Text size="xs" c="dimmed">
                      {formatDateTime(step.at)}{step.detail ? ` · ${step.detail}` : ""}
                    </Text>
                  </Box>
                ))}
              </Stack>
            </Stack>
          </Tabs.Panel>
        ) : null}
        <Tabs.Panel value="raw" pt="sm">
          <Text component="pre" size="xs" ff="monospace" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {JSON.stringify(entry.detail, null, 2)}
          </Text>
        </Tabs.Panel>
        <Tabs.Panel value="links" pt="sm">
          {entry.correlationId || entry.causationId ? (
            <Stack gap={4}>
              <Text size="sm" ff="monospace"><strong>Operation:</strong> {entry.correlationId ?? "Not stored"}</Text>
              <Text size="sm" ff="monospace"><strong>Caused by:</strong> {entry.causationId ?? "Not stored"}</Text>
            </Stack>
          ) : (
            <Text size="sm" c="dimmed">No operation links were stored for this record.</Text>
          )}
        </Tabs.Panel>
      </Tabs>
    </section>
  );
}

export function AuditView({ typePrefix = "" }: { readonly typePrefix?: string } = {}) {
  const normalizedTypePrefix = typePrefix.trim();
  const [category, setCategory] = useState<"All" | OperationsLogEntry["category"]>("All");
  const [selectedEntry, setSelectedEntry] = useState<OperationsLogEntry | null>(null);
  const [layout, setLayout] = useState<GridLayout>(() => loadGridLayout(AUDIT_LAYOUT_KEY, DEFAULT_AUDIT_LAYOUT));
  const [windowMinutes, setWindowMinutes] = useState<TimelineWindowMinutes>(1_440);
  const live = useLiveEventFeed(normalizedTypePrefix ? { typePrefix: normalizedTypePrefix } : {});
  const narrowInspector = useMediaQuery("(max-width: 74.99em)") ?? false;
  const q = useQuery({
    queryKey: ["admin", "operations-log", normalizedTypePrefix],
    queryFn: async ({ signal }) => {
      const [audit, operations] = await Promise.all([
        api.auditLog(200, { signal }),
        api.events({
          ...(normalizedTypePrefix ? { typePrefix: normalizedTypePrefix } : {}),
          limit: 500,
        }, { signal }),
      ]);
      const merged = mergeOperationsLog(audit.entries, operations.events);
      return normalizedTypePrefix
        ? merged.filter((entry) => entry.action.startsWith(normalizedTypePrefix))
        : merged;
    },
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const entries = useMemo(
    () => category === "All" ? (q.data ?? []) : (q.data ?? []).filter((entry) => entry.category === category),
    [category, q.data],
  );
  const liveEntries = useMemo(
    () => live.events
      .filter((event) => !normalizedTypePrefix || event.type.startsWith(normalizedTypePrefix))
      .map(eventLogEntry),
    [live.events, normalizedTypePrefix],
  );
  const timelineEntries = useMemo(
    () => mergeTimelineEntries(entries, category === "All" ? liveEntries : liveEntries.filter((entry) => entry.category === category)),
    [category, entries, liveEntries],
  );
  if (q.isPending) return <LoadState />;
  if (q.isError) return <ErrorState message={(q.error as Error).message} onRetry={() => void q.refetch()} />;

  const columns: ReadonlyArray<ColumnDef<OperationsLogEntry, unknown>> = [
    {
      id: "occurredAt",
      header: "When",
      accessorKey: "occurredAt",
      size: 150,
      cell: ({ row }) => <Text size="xs">{formatDateTime(row.original.occurredAt)}</Text>,
      meta: { dataType: "time" },
    },
    {
      id: "category",
      header: "Category",
      accessorKey: "category",
      size: 116,
      cell: ({ row }) => <Text size="xs">{row.original.category}</Text>,
    },
    { id: "source", header: "Source", accessorKey: "source", size: 72 },
    { id: "actor", header: "Actor", accessorKey: "actor", size: 135 },
    { id: "action", header: "Action", accessorKey: "action", size: 210 },
    { id: "target", header: "Target", accessorKey: "target", size: 165 },
    {
      id: "trace",
      header: "Trace",
      size: 180,
      accessorFn: (r) => [r.correlationId, r.causationId].filter(Boolean).join(" "),
      cell: ({ row }) => (
        <Text size="xs" ff="monospace">
          {row.original.correlationId ?? row.original.causationId ?? "—"}
        </Text>
      ),
    },
  ];

  return (
    <Stack gap="sm" data-testid="audit-view">
      <Group justify="flex-end" gap="xs">
        <Button variant="default" onClick={() => {
          setSelectedEntry(null);
          void q.refetch();
        }}>Refresh</Button>
        <Button variant="default" disabled={entries.length === 0} onClick={() => downloadAuditLog(entries)}>
          Export JSON
        </Button>
      </Group>
      <AuditActivityMap
        entries={timelineEntries}
        selectedId={selectedEntry?.id}
        onSelect={setSelectedEntry}
        windowMinutes={windowMinutes}
        onWindowMinutesChange={setWindowMinutes}
        liveStatus={live.status}
      />
      <div className="tantalar-audit-workspace" data-inspector-open={Boolean(selectedEntry) || undefined}>
        <Box className="tantalar-audit-workspace__log">
          <DenseGrid
            testId="audit-grid"
            columns={columns}
            data={entries}
            layout={layout}
            onLayoutChange={(next) => {
              setLayout(next);
              saveGridLayout(AUDIT_LAYOUT_KEY, next);
            }}
            ariaLabel="operations log"
            emptyMessage={category === "All" ? "No loaded records yet." : `No loaded ${category.toLowerCase()} records yet.`}
            pagination
            paginationResetKey={category}
            onRowActivate={setSelectedEntry}
            isRowSelected={(entry) => entry.id === selectedEntry?.id}
            rowAriaLabel={(entry) => `Inspect ${entry.action}`}
            toolbarStart={(
              <NativeSelect
                aria-label="Log category"
                value={category}
                onChange={(event) => {
                  setCategory(event.currentTarget.value as typeof category);
                  setSelectedEntry(null);
                }}
                data={[
                  { value: "All", label: "All categories" },
                  ...OPERATIONS_LOG_CATEGORIES.map((value) => ({ value, label: value })),
                ]}
                w={220}
              />
            )}
          />
        </Box>
        {!narrowInspector ? (
          <aside className="tantalar-audit-workspace__inspector" aria-label="Audit inspector panel">
            {selectedEntry ? (
              <OperationsLogInspector entry={selectedEntry} onClose={() => setSelectedEntry(null)} />
            ) : null}
          </aside>
        ) : null}
      </div>
      <Drawer
        opened={narrowInspector && selectedEntry !== null}
        onClose={() => setSelectedEntry(null)}
        position="right"
        size="100%"
        title="Inspect operation"
      >
        {selectedEntry ? <OperationsLogInspector entry={selectedEntry} onClose={() => setSelectedEntry(null)} /> : null}
      </Drawer>
    </Stack>
  );
}

// ---- Settings / theme editor --------------------------------------------------

export function SettingsView({ adminId }: { adminId: string | null }) {
  const theme = useTheme();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<ReadonlyArray<string>>([]);
  const [status, setStatus] = useState<string | null>(null);

  const tokenKeys = Object.keys(DEFAULT_TOKENS);

  const previewToken = (key: string, value: string) => {
    const next = { ...values, [`--tantalar-${key}`]: value };
    setValues(next);
    const res = theme.applyPreview(next);
    setErrors(res.ok ? [] : (res.errors ?? []));
  };

  const saveTheme = async () => {
    setErrors([]);
    setStatus(null);
    const merged: Record<string, string> = {};
    for (const k of tokenKeys) {
      const v = values[`${TOKEN_PREFIX}${k}`];
      if (v !== undefined && v !== "") merged[`${TOKEN_PREFIX}${k}`] = v;
    }
    const check = sanitizeTokenOverrides(merged);
    if (!check.ok) {
      setErrors(check.errors);
      return;
    }
    try {
      await theme.save(name || "custom", check.tokens);
      setStatus("Theme saved.");
      setName("");
      setValues({});
      if (adminId) void qc.invalidateQueries({ queryKey: ["prefs"] });
    } catch (err) {
      setErrors([(err as Error).message]);
    }
  };

  return (
    <Stack gap="md" data-testid="settings-view">
      <Title order={4}>Settings · Theme editor</Title>
      <Text size="sm" c="var(--tantalar-color-text-dimmed)">
        Overrides apply to both the admin UI and the player immediately. Values accept plain CSS token values only —
        colors like <code>#4d8df6</code> or lengths like <code>6px</code>. Scripts, URLs and at-rules are rejected.
      </Text>

      <Stack gap="xs" data-testid="theme-editor">
        <TextInput
          label="Theme name"
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          placeholder="midnight-blue"
        />
        {tokenKeys.map((key) => (
          <TextInput
            key={key}
            aria-label={TOKEN_LABELS[key] ?? key}
            label={TOKEN_LABELS[key] ?? key}
            value={values[`${TOKEN_PREFIX}${key}`] ?? ""}
            placeholder={DEFAULT_TOKENS[key]}
            onChange={(e) => previewToken(key, e.currentTarget.value)}
          />
        ))}
        {errors.length > 0 ? (
          <div role="alert" data-testid="theme-errors">
            {errors.map((e) => (
              <Text key={e} size="sm" c="var(--tantalar-color-danger)">{e}</Text>
            ))}
          </div>
        ) : null}
        <Group>
          <Button data-testid="save-theme" onClick={() => void saveTheme()}>Save theme</Button>
          <Button
            variant="default"
            data-testid="revert-theme"
            onClick={() => {
              theme.revert();
              setValues({});
              setErrors([]);
              setStatus(null);
            }}
          >
            Revert
          </Button>
        </Group>
        {status ? <Text size="sm" c="var(--tantalar-color-success)">{status}</Text> : null}
      </Stack>
    </Stack>
  );
}

// ---- System health view -------------------------------------------------------

export function SystemHealthView() {
  const q = useAdminQuery(["admin", "health"], () => api.systemHealth());
  if (q.isPending) return <LoadState />;
  if (q.isError) return <ErrorState message={(q.error as Error).message} onRetry={() => void q.refetch()} />;

  const unhealthyPlugins = q.data.plugins.filter((p) => p.state !== "healthy" && p.state !== "running");
  const fixturePlugins = q.data.plugins.filter((p) => p.id.includes(".fixture-"));
  const runtimeDegraded = q.data.ready === false || q.data.eventCount === null || unhealthyPlugins.length > 0;
  const setupLimitations = [
    ...q.data.missingCapabilities.map((capability) => `Missing capability: ${capability}`),
    ...(!q.data.transcoder.ffmpegAvailable ? ["FFmpeg is unavailable; transcoding cannot run."] : []),
    ...(!q.data.network.vpnCapabilityMounted ? ["VPN control is not mounted; protected routing is unavailable."] : []),
    ...(fixturePlugins.length > 0
      ? [`Development fixtures are active: ${fixturePlugins.map((plugin) => plugin.id).join(", ")}.`]
      : []),
  ];
  return (
    <Stack gap="sm" data-testid="system-health">
      <Title order={4}>System health</Title>
      {runtimeDegraded ? (
        <Alert color="yellow" title="Degraded service">
          <Text size="sm">The runtime is not fully operational. Review the states below before relying on automation.</Text>
        </Alert>
      ) : setupLimitations.length > 0 ? (
        <Alert color="yellow" title="Alpha setup incomplete">
          <Stack gap={4}>
            {setupLimitations.map((limitation) => <Text size="sm" key={limitation}>{limitation}</Text>)}
          </Stack>
        </Alert>
      ) : (
        <Text c="var(--tantalar-color-success)">Configured capabilities are ready.</Text>
      )}
      <Text>Runtime ready: {String(q.data.ready)}</Text>
      <Text>Events in log: {q.data.eventCount === null ? "unknown" : q.data.eventCount}</Text>
      <Stack gap="xs">
        {q.data.plugins.map((p) => (
          <Group key={p.id} justify="space-between">
            <Text size="sm">{p.id}</Text>
            <Text size="sm" c={p.state === "healthy" || p.state === "running" ? "var(--tantalar-color-success)" : "var(--tantalar-color-warning)"}>
              {p.state} · {p.restarts} restarts
            </Text>
          </Group>
        ))}
      </Stack>
    </Stack>
  );
}

// ---- Activity / Trajectory view ---------------------------------------------

export function ActivityView() {
  const [typePrefix, setTypePrefix] = useState("");
  const [subject, setSubject] = useState("");
  const [correlationId, setCorrelationId] = useState(() => new URLSearchParams(window.location.hash.split("?")[1]).get("correlationId") ?? "");
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [layout, setLayout] = useState<GridLayout>(() => loadGridLayout(TRACE_LAYOUT_KEY, DEFAULT_TRACE_LAYOUT));
  const [windowMinutes, setWindowMinutes] = useState<TimelineWindowMinutes>(1_440);
  const narrowInspector = useMediaQuery("(max-width: 74.99em)") ?? false;
  const [debouncedTypePrefix] = useDebouncedValue(typePrefix.trim(), 300);
  const [debouncedSubject] = useDebouncedValue(subject.trim(), 300);
  const [debouncedCorrelationId] = useDebouncedValue(correlationId.trim(), 300);
  const live = useLiveEventFeed({
    ...(debouncedTypePrefix ? { typePrefix: debouncedTypePrefix } : {}),
    ...(debouncedSubject ? { subject: debouncedSubject } : {}),
    ...(debouncedCorrelationId ? { correlationId: debouncedCorrelationId } : {}),
  });

  const q = useQuery({
    queryKey: ["admin", "trace", debouncedTypePrefix, debouncedSubject, debouncedCorrelationId],
    queryFn: ({ signal }) =>
      api.events({
        ...(debouncedTypePrefix ? { typePrefix: debouncedTypePrefix } : {}),
        ...(debouncedSubject ? { subject: debouncedSubject } : {}),
        ...(debouncedCorrelationId ? { correlationId: debouncedCorrelationId } : {}),
        limit: 500,
      }, { signal }),
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    setSelectedEventId(null);
  }, [debouncedTypePrefix, debouncedSubject, debouncedCorrelationId]);

  const entries = useMemo(() => (q.data?.events ?? []).map(eventLogEntry), [q.data]);
  const liveEntries = useMemo(() => live.events.map(eventLogEntry), [live.events]);
  const timelineEntries = useMemo(() => mergeTimelineEntries(entries, liveEntries), [entries, liveEntries]);
  const selectedEntry = [...entries, ...liveEntries].find((entry) => entry.id === `event:${selectedEventId}`) ?? null;
  const chains = useMemo(() => {
    const events = new Map<string, TrajectoryEvent>();
    for (const event of [...(q.data?.events ?? []), ...live.events]) events.set(event.eventId, event);
    return assembleChains([...events.values()]);
  }, [live.events, q.data?.events]);
  const selectedChain = selectedEntry?.correlationId
    ? chains.find((chain) => chain.correlationId === selectedEntry.correlationId)
    : undefined;
  const narrative = selectedChain ? reconstructDecision(selectedChain) : null;
  const selectEntry = (entry: OperationsLogEntry) => setSelectedEventId(entry.id.replace(/^event:/, ""));

  const columns: ReadonlyArray<ColumnDef<OperationsLogEntry, unknown>> = [
    { id: "occurredAt", header: "When", accessorKey: "occurredAt", size: 150, cell: ({ row }) => <Text size="xs">{formatDateTime(row.original.occurredAt)}</Text>, meta: { dataType: "time" } },
    { id: "category", header: "Category", accessorKey: "category", size: 116, cell: ({ row }) => <Text size="xs">{row.original.category}</Text> },
    { id: "action", header: "Operation", accessorKey: "action", size: 250 },
    { id: "target", header: "Subject", accessorKey: "target", size: 180 },
    { id: "source", header: "Source", accessorKey: "actor", size: 90 },
    { id: "trace", header: "Trace", accessorFn: (entry) => entry.correlationId ?? entry.causationId ?? "—", size: 180 },
  ];

  return (
    <Stack gap="sm" data-testid="activity-view" className="tantalar-trace-view">
      <Group justify="flex-end" gap="xs">
        <Button variant="default" onClick={() => {
          setSelectedEventId(null);
          void q.refetch();
        }}>Refresh</Button>
        <Button variant="default" disabled={entries.length === 0} onClick={() => downloadAuditLog(entries)}>
          Export JSON
        </Button>
      </Group>
      <AuditActivityMap
        entries={timelineEntries}
        selectedId={selectedEntry?.id}
        onSelect={selectEntry}
        windowMinutes={windowMinutes}
        onWindowMinutesChange={setWindowMinutes}
        liveStatus={live.status}
      />
      {q.isError ? <ErrorState message={(q.error as Error).message} onRetry={() => void q.refetch()} /> : null}
      <div className="tantalar-audit-workspace" data-inspector-open={Boolean(selectedEntry) || undefined}>
        <main className="tantalar-audit-workspace__log">
          <DenseGrid
            testId="trace-grid"
            columns={columns}
            data={entries}
            layout={layout}
            onLayoutChange={(next) => {
              setLayout(next);
              saveGridLayout(TRACE_LAYOUT_KEY, next);
            }}
            loading={q.isPending}
            ariaLabel="operation trace"
            emptyMessage="No operations match those filters."
            pagination
            paginationResetKey={`${debouncedTypePrefix}:${debouncedSubject}:${debouncedCorrelationId}`}
            onRowActivate={selectEntry}
            isRowSelected={(entry) => entry.id === selectedEntry?.id}
            rowAriaLabel={(entry) => `Inspect ${entry.action}`}
            toolbarStart={(
              <details className="tantalar-trace-filters">
                <summary>Trace filters</summary>
                <Group wrap="wrap" mt="xs">
                  <TextInput
                    aria-label="Filter by event type prefix"
                    placeholder="Event type"
                    value={typePrefix}
                    onChange={(e) => setTypePrefix(e.currentTarget.value)}
                    w={180}
                  />
                  <TextInput
                    aria-label="Filter by subject"
                    placeholder="Subject"
                    value={subject}
                    onChange={(e) => setSubject(e.currentTarget.value)}
                    w={180}
                  />
                  <TextInput
                    aria-label="Filter by operation id"
                    placeholder="Operation ID"
                    value={correlationId}
                    onChange={(e) => setCorrelationId(e.currentTarget.value)}
                    w={180}
                  />
                </Group>
              </details>
            )}
          />
        </main>
        {!narrowInspector ? (
        <aside className="tantalar-audit-workspace__inspector" aria-label="Trace inspector panel">
            {selectedEntry ? (
              <OperationsLogInspector entry={selectedEntry} onClose={() => setSelectedEventId(null)} narrative={narrative} />
            ) : null}
          </aside>
        ) : null}
      </div>
      <Drawer
        opened={narrowInspector && selectedEntry !== null}
        onClose={() => setSelectedEventId(null)}
        position="right"
        size="100%"
        title="Inspect event"
      >
        {selectedEntry ? (
          <OperationsLogInspector entry={selectedEntry} onClose={() => setSelectedEventId(null)} narrative={narrative} />
        ) : null}
      </Drawer>
    </Stack>
  );
}

// ---- Grid persistence helper (used by the admin shell) -------------------------

export function usePersistedGridPrefs(adminId: string | null) {
  const qc = useQueryClient();
  const prefsQ = useAdminQuery(["prefs", adminId], async () =>
    adminId ? api.uiPreferences(adminId) : { preferences: {} },
  );
  const [layout, setLayout] = useState<GridLayout>({ hiddenColumns: [], density: "dense" });
  useEffect(() => {
    const p = prefsQ.data?.preferences as { gridDensity?: string; hiddenColumns?: string[] } | undefined;
    if (!p) return;
    setLayout({
      density: p.gridDensity === "comfortable" ? "comfortable" : "dense",
      hiddenColumns: Array.isArray(p.hiddenColumns) ? p.hiddenColumns : [],
    });
  }, [prefsQ.data]);

  const update = (next: GridLayout) => {
    setLayout(next);
    if (adminId) {
      void api
        .saveUiPreferences(adminId, {
          gridDensity: next.density,
          hiddenColumns: [...next.hiddenColumns],
        })
        .then(() => qc.invalidateQueries({ queryKey: ["prefs"] }));
    }
  };
  return { layout, update };
}

/** Small toggle used by the settings tab for density preference. */
export function DensityToggle({ adminId }: { adminId: string | null }) {
  const { layout, update } = usePersistedGridPrefs(adminId);
  return (
    <Switch
      label="Comfortable density grids"
      checked={layout.density === "comfortable"}
      onChange={(e) => update({ ...layout, density: e.currentTarget.checked ? "comfortable" : "dense" })}
    />
  );
}

export function AdminTabs({ adminId }: { adminId: string | null }) {
  return (
    <Tabs defaultValue="queue" keepMounted={false}>
      <Tabs.List role="tablist">
        <Tabs.Tab value="queue">Queue</Tabs.Tab>
        <Tabs.Tab value="wanted">Wanted</Tabs.Tab>
        <Tabs.Tab value="history">History</Tabs.Tab>
        <Tabs.Tab value="plugins">Plugins</Tabs.Tab>
        <Tabs.Tab value="users">Users</Tabs.Tab>
        <Tabs.Tab value="activity">Activity</Tabs.Tab>
        <Tabs.Tab value="audit">Audit</Tabs.Tab>
        <Tabs.Tab value="settings">Settings</Tabs.Tab>
        <Tabs.Tab value="system">System</Tabs.Tab>
      </Tabs.List>
      <Tabs.Panel value="queue" pt="sm"><QueueView adminId={adminId} /></Tabs.Panel>
      <Tabs.Panel value="wanted" pt="sm"><WantedView adminId={adminId} /></Tabs.Panel>
      <Tabs.Panel value="history" pt="sm"><HistoryView adminId={adminId} /></Tabs.Panel>
      <Tabs.Panel value="plugins" pt="sm"><PluginsView /></Tabs.Panel>
      <Tabs.Panel value="users" pt="sm"><UsersView /></Tabs.Panel>
      <Tabs.Panel value="activity" pt="sm"><ActivityView /></Tabs.Panel>
      <Tabs.Panel value="audit" pt="sm"><AuditView /></Tabs.Panel>
      <Tabs.Panel value="settings" pt="sm"><SettingsView adminId={adminId} /><DensityToggle adminId={adminId} /></Tabs.Panel>
      <Tabs.Panel value="system" pt="sm"><SystemHealthView /></Tabs.Panel>
    </Tabs>
  );
}
