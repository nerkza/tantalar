import {
  ActionIcon,
  Button,
  Group,
  NativeSelect,
  NumberInput,
  Paper,
  SimpleGrid,
  Stack,
  Switch,
  Tabs,
  Text,
  Title,
  VisuallyHidden,
} from "@mantine/core";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  IconCheckmarkCircle,
  IconExclamationmarkTriangle,
  IconXmark,
  IconXmarkCircle,
} from "symbols-react";
import { api, type TrajectoryEvent, type NotificationHistoryEntry } from "./api";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CollectionUserContext, DenseGrid, type ExplorerQuery } from "./admin/DenseGrid";
import { formatDateTime } from "./date";
import type { Route } from "./App";
import { useLiveEventFeed } from "./live-event-feed";
import "./notifications.css";

export type NoticeSeverity = "success" | "warning" | "error";
export type NotificationCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export interface Notice {
  readonly key: string;
  readonly severity: NoticeSeverity;
  readonly title: string;
  readonly message?: string;
  readonly route?: Route;
  readonly actionLabel?: string;
  readonly durationMs?: number | null;
  readonly correlationId?: string;
  readonly createdAt?: string;
}

export interface NotificationPreferences {
  readonly enabled: boolean;
  readonly corner: NotificationCorner;
  readonly maxVisible: number;
  readonly minimumSeverity: NoticeSeverity;
  readonly durations: Readonly<Record<NoticeSeverity, number>>;
  readonly events: {
    readonly downloads: boolean;
    readonly imports: boolean;
    readonly plugins: boolean;
    readonly vpn: boolean;
    readonly indexers: boolean;
  };
}

export interface NoticeOutcome<T> {
  readonly success: Notice | ((result: T) => Notice);
  readonly error: Notice | ((error: unknown) => Notice);
}

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  enabled: true,
  corner: "bottom-right",
  maxVisible: 3,
  minimumSeverity: "success",
  durations: { success: 5_000, warning: 8_000, error: 12_000 },
  events: { downloads: true, imports: true, plugins: true, vpn: true, indexers: true },
};

const CORNERS = new Set<NotificationCorner>(["top-left", "top-right", "bottom-left", "bottom-right"]);
const SEVERITIES = new Set<NoticeSeverity>(["success", "warning", "error"]);
const SEVERITY_RANK: Record<NoticeSeverity, number> = { success: 0, warning: 1, error: 2 };
const MAX_QUEUED_NOTICES = 50;
const EVENT_DEDUPE_LIMIT = 1_000;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
}

export function normalizeNotificationPreferences(value: unknown): NotificationPreferences {
  const raw = record(value);
  const durations = record(raw.durations);
  const events = record(raw.events);
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_NOTIFICATION_PREFERENCES.enabled,
    corner: typeof raw.corner === "string" && CORNERS.has(raw.corner as NotificationCorner)
      ? raw.corner as NotificationCorner
      : DEFAULT_NOTIFICATION_PREFERENCES.corner,
    maxVisible: boundedInteger(raw.maxVisible, DEFAULT_NOTIFICATION_PREFERENCES.maxVisible, 1, 5),
    minimumSeverity: typeof raw.minimumSeverity === "string" && SEVERITIES.has(raw.minimumSeverity as NoticeSeverity)
      ? raw.minimumSeverity as NoticeSeverity
      : DEFAULT_NOTIFICATION_PREFERENCES.minimumSeverity,
    durations: {
      success: boundedInteger(durations.success, DEFAULT_NOTIFICATION_PREFERENCES.durations.success, 1_000, 300_000),
      warning: boundedInteger(durations.warning, DEFAULT_NOTIFICATION_PREFERENCES.durations.warning, 1_000, 300_000),
      error: boundedInteger(durations.error, DEFAULT_NOTIFICATION_PREFERENCES.durations.error, 1_000, 300_000),
    },
    events: {
      downloads: typeof events.downloads === "boolean" ? events.downloads : true,
      imports: typeof events.imports === "boolean" ? events.imports : true,
      plugins: typeof events.plugins === "boolean" ? events.plugins : true,
      vpn: typeof events.vpn === "boolean" ? events.vpn : true,
      indexers: typeof events.indexers === "boolean" ? events.indexers : true,
    },
  };
}

const EVENT_TYPES = {
  downloadCompleted: "dev.tantalar.event.download.completed",
  downloadFailed: "dev.tantalar.event.download.failed",
  importCompleted: "dev.tantalar.event.import.completed",
  importFailed: "dev.tantalar.event.import.failed",
  pluginMounted: "dev.tantalar.event.plugin.mounted",
  pluginUnmounted: "dev.tantalar.event.plugin.unmounted",
  pluginCrashed: "dev.tantalar.event.plugin.crashed",
  pluginRestarted: "dev.tantalar.event.plugin.restarted",
  pluginFailed: "dev.tantalar.event.plugin.failed",
  tunnelHealthChanged: "dev.tantalar.event.tunnel.health.changed",
  indexerProviderError: "dev.tantalar.event.indexer.provider.error",
  indexerCapsRefreshed: "dev.tantalar.event.indexer.caps.refreshed",
} as const;

function eventNotice(event: TrajectoryEvent, notice: Omit<Notice, "key" | "correlationId">): Notice {
  return {
    ...notice,
    key: `event:${event.eventId}`,
    createdAt: event.occurredAt,
    correlationId: event.correlationId,
  };
}

/** Map reviewed terminal events only. Payload text never reaches the notice surface. */
export function noticeForLiveEvent(
  event: TrajectoryEvent,
  preferences: NotificationPreferences,
): Notice | null {
  switch (event.type) {
    case EVENT_TYPES.downloadCompleted:
      return preferences.events.downloads ? eventNotice(event, {
        severity: "success",
        title: "Download completed",
        message: "A download finished successfully.",
        route: { name: "admin", area: "acquisition", child: "downloads" },
        actionLabel: "Open Downloads",
      }) : null;
    case EVENT_TYPES.downloadFailed:
      return preferences.events.downloads ? eventNotice(event, {
        severity: "error",
        title: "Download failed",
        message: "Open Downloads for the failure details.",
        route: { name: "admin", area: "acquisition", child: "downloads" },
        actionLabel: "Open Downloads",
      }) : null;
    case EVENT_TYPES.importCompleted:
      return preferences.events.imports ? eventNotice(event, {
        severity: "success",
        title: "Import completed",
        message: "A library import finished successfully.",
        route: { name: "admin", area: "media" },
        actionLabel: "Open Media",
      }) : null;
    case EVENT_TYPES.importFailed:
      return preferences.events.imports ? eventNotice(event, {
        severity: "error",
        title: "Import failed",
        message: "Open Media for the failure details.",
        route: { name: "admin", area: "media" },
        actionLabel: "Open Media",
      }) : null;
    case EVENT_TYPES.pluginMounted:
    case EVENT_TYPES.pluginRestarted:
      return preferences.events.plugins ? eventNotice(event, {
        severity: "success",
        title: event.type === EVENT_TYPES.pluginMounted ? "Plugin started" : "Plugin restarted",
        message: "The plugin is ready.",
        route: { name: "admin", area: "extensions" },
        actionLabel: "Open Extensions",
      }) : null;
    case EVENT_TYPES.pluginUnmounted:
    case EVENT_TYPES.pluginCrashed:
      return preferences.events.plugins ? eventNotice(event, {
        severity: "warning",
        title: event.type === EVENT_TYPES.pluginCrashed ? "Plugin crashed" : "Plugin stopped",
        message: "Open Extensions to review its state.",
        route: { name: "admin", area: "extensions" },
        actionLabel: "Open Extensions",
      }) : null;
    case EVENT_TYPES.pluginFailed:
      return preferences.events.plugins ? eventNotice(event, {
        severity: "error",
        title: "Plugin failed",
        message: "Open Extensions for recovery actions.",
        route: { name: "admin", area: "extensions" },
        actionLabel: "Open Extensions",
      }) : null;
    case EVENT_TYPES.tunnelHealthChanged: {
      if (!preferences.events.vpn) return null;
      const payload = record(event.payload);
      const health = payload.health;
      if (health !== "healthy" && health !== "degraded" && health !== "down") return null;
      const healthy = health === "healthy";
      return eventNotice(event, {
        severity: healthy ? "success" : "error",
        title: healthy ? "VPN tunnel recovered" : "VPN tunnel unavailable",
        message: healthy ? "The acquisition tunnel is healthy." : "Downloads may be blocked until the tunnel recovers.",
        route: { name: "admin", area: "acquisition", child: "vpn" },
        actionLabel: "Open VPN",
      });
    }
    case EVENT_TYPES.indexerProviderError:
      return preferences.events.indexers ? eventNotice(event, {
        severity: "error",
        title: "Indexer unavailable",
        message: "Open Indexers for provider diagnostics.",
        route: { name: "admin", area: "acquisition", child: "indexers" },
        actionLabel: "Open Indexers",
      }) : null;
    case EVENT_TYPES.indexerCapsRefreshed:
      return preferences.events.indexers ? eventNotice(event, {
        severity: "success",
        title: "Indexer capabilities refreshed",
        route: { name: "admin", area: "acquisition", child: "indexers" },
        actionLabel: "Open Indexers",
      }) : null;
    default:
      return null;
  }
}

interface QueueItem {
  readonly id: string;
  readonly notice: Notice;
  readonly count: number;
  readonly revision: number;
  readonly source: "local" | "event";
  readonly closing: boolean;
}

type ShowNotice = (notice: Notice) => string;
let activeShow: ShowNotice | null = null;
let noticeSequence = 0;

function noticeId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `notice-${++noticeSequence}`;
}

/** Show a notice through the mounted application provider. */
export function show(notice: Notice): string {
  return activeShow?.(notice) ?? "";
}

async function runWith<T>(showNotice: ShowNotice, work: Promise<T> | (() => Promise<T>), outcome: NoticeOutcome<T>): Promise<T> {
  try {
    const result = await (typeof work === "function" ? work() : work);
    showNotice(typeof outcome.success === "function" ? outcome.success(result) : outcome.success);
    return result;
  } catch (error) {
    showNotice(typeof outcome.error === "function" ? outcome.error(error) : outcome.error);
    throw error;
  }
}

/** Run asynchronous work and translate its explicit result into structured feedback. */
export function run<T>(work: Promise<T> | (() => Promise<T>), outcome: NoticeOutcome<T>): Promise<T> {
  return runWith(show, work, outcome);
}

interface NotificationContextValue {
  readonly historyVersion: number;
  readonly historyError: boolean;
  readonly preferences: NotificationPreferences;
  readonly preferencesReady: boolean;
  readonly preferencesError: boolean;
  readonly savingPreferences: boolean;
  readonly show: ShowNotice;
  readonly run: <T>(work: Promise<T> | (() => Promise<T>), outcome: NoticeOutcome<T>) => Promise<T>;
  readonly savePreferences: (preferences: NotificationPreferences) => Promise<void>;
}

const NotificationContext = createContext<NotificationContextValue | null>(null);

export function useNotifications(): NotificationContextValue {
  const value = useContext(NotificationContext);
  if (!value) throw new Error("useNotifications must be used inside NotificationProvider");
  return value;
}

function NoticeCard({
  item,
  durationMs,
  onDismiss,
  onActivate,
}: {
  readonly item: QueueItem;
  readonly durationMs: number | null;
  readonly onDismiss: () => void;
  readonly onActivate: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const remaining = useRef(durationMs ?? 0);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  useEffect(() => {
    const releasePause = () => { if (document.visibilityState === "hidden") { setHovered(false); setFocused(false); } };
    document.addEventListener("visibilitychange", releasePause);
    return () => document.removeEventListener("visibilitychange", releasePause);
  }, []);
  const Icon = item.notice.severity === "success"
    ? IconCheckmarkCircle
    : item.notice.severity === "warning"
      ? IconExclamationmarkTriangle
      : IconXmarkCircle;

  useEffect(() => {
    remaining.current = durationMs ?? 0;
  }, [durationMs]);

  useEffect(() => {
    if (durationMs === null || hovered || focused || item.closing) return;
    const startedAt = Date.now();
    const timer = window.setTimeout(() => dismissRef.current(), remaining.current);
    return () => {
      window.clearTimeout(timer);
      remaining.current = Math.max(0, remaining.current - (Date.now() - startedAt));
    };
  }, [durationMs, focused, hovered, item.closing]);

  const severityLabel = item.notice.severity === "success"
    ? "Success"
    : item.notice.severity === "warning"
      ? "Warning"
      : "Error";

  return (
    <article
      className="tantalar-notice"
      data-severity={item.notice.severity}
      data-closing={item.closing || undefined}
      role={item.notice.severity === "error" ? "alert" : "status"}
      aria-live={item.notice.severity === "error" ? "assertive" : "polite"}
      aria-atomic="true"
      onPointerMove={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
      }}
    >
      <div className="tantalar-notice__body">
        <Icon className="tantalar-notice__icon" aria-hidden="true" />
        <div>
          <VisuallyHidden>{severityLabel}</VisuallyHidden>
          <Text className="tantalar-notice__title" size="sm" fw={650}>
            {item.notice.title}{item.count > 1 ? ` (${item.count})` : ""}
          </Text>
          {item.notice.message ? <Text className="tantalar-notice__message" size="xs">{item.notice.message}</Text> : null}
        </div>
      </div>
      <ActionIcon
        className="tantalar-notice__dismiss"
        variant="subtle"
        size="sm"
        aria-label={`Dismiss ${item.notice.title}`}
        onClick={onDismiss}
      >
        <IconXmark fill="currentColor" aria-hidden="true" />
      </ActionIcon>
      {item.notice.route ? (
        <Button className="tantalar-notice__activate" variant="subtle" size="compact-sm" onClick={onActivate}>
          {item.notice.actionLabel ?? "Open details"}
        </Button>
      ) : null}
    </article>
  );
}

export function NotificationProvider({
  userId,
  isAdmin,
  navigate,
  children,
}: {
  readonly userId: string | null;
  readonly isAdmin: boolean;
  readonly navigate: (route: Route) => void;
  readonly children: ReactNode;
}) {
  const [preferences, setPreferences] = useState(DEFAULT_NOTIFICATION_PREFERENCES);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [preferencesError, setPreferencesError] = useState(false);
  const [savingPreferences, setSavingPreferences] = useState(false);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [historyError, setHistoryError] = useState(false);
  const historyEntries = useRef(new Map<string, NotificationHistoryEntry>());
  const historyWrites = useRef<Promise<unknown>>(Promise.resolve());
  const historyAccount = useRef(userId);
  historyAccount.current = userId;
  const closeTimers = useRef(new Map<string, number>());
  const seenEventIds = useRef(new Set<string>());
  const correlations = useRef(new Map<string, { readonly source: "local" | "event"; readonly at: number }>());

  useEffect(() => {
    setPreferences(DEFAULT_NOTIFICATION_PREFERENCES);
    setPreferencesReady(false);
    setPreferencesError(false);
    setQueue([]);
    historyEntries.current.clear();
    setHistoryError(false);
    seenEventIds.current.clear();
    correlations.current.clear();
    for (const timer of closeTimers.current.values()) window.clearTimeout(timer);
    closeTimers.current.clear();
    if (!userId || typeof api.uiPreferences !== "function") {
      setPreferencesReady(true);
      return;
    }
    let active = true;
    void api.uiPreferences(userId).then(({ preferences: stored }) => {
      if (active) setPreferences(normalizeNotificationPreferences(stored.notifications));
    }).catch(() => {
      if (active) setPreferencesError(true);
    }).finally(() => {
      if (active) setPreferencesReady(true);
    });
    return () => {
      active = false;
    };
  }, [userId]);

  useEffect(() => {
    historyAccount.current = userId;
    return () => {
      historyAccount.current = null;
      for (const timer of closeTimers.current.values()) window.clearTimeout(timer);
    };
  }, [userId]);

  useEffect(() => {
    if (!preferences.enabled) setQueue([]);
  }, [preferences.enabled]);

  const enqueue = useCallback((notice: Notice, source: "local" | "event" = "local") => {
    if (!preferencesReady) return "";
    const now = Date.now();
    if (notice.correlationId) {
      const previous = correlations.current.get(notice.correlationId);
      if (previous && previous.source !== source && now - previous.at < 60_000) return "";
      correlations.current.set(notice.correlationId, { source, at: now });
      if (correlations.current.size > 200) correlations.current.delete(correlations.current.keys().next().value!);
    }
    const previous = historyEntries.current.get(notice.key);
    const repeat = previous && now - Date.parse(previous.createdAt) < 60_000;
    const entry: NotificationHistoryEntry = {
      id: repeat ? previous.id : source === "event" ? notice.key : noticeId(),
      severity: notice.severity,
      title: notice.title.slice(0, 300),
      message: notice.message?.slice(0, 2000),
      createdAt: repeat ? previous.createdAt : notice.createdAt ?? new Date(now).toISOString(),
      count: repeat ? previous.count + 1 : 1,
    };
    historyEntries.current.set(notice.key, entry);
    if (historyEntries.current.size > MAX_QUEUED_NOTICES) historyEntries.current.delete(historyEntries.current.keys().next().value!);
    if (userId) {
      historyWrites.current = historyWrites.current.then(async () => {
        if (historyAccount.current !== userId) return;
        try {
          await api.saveNotification(entry);
          if (historyAccount.current === userId) setHistoryVersion(value => value + 1);
        } catch {
          if (historyAccount.current === userId) setHistoryError(true);
        }
      });
    }
    if (!preferences.enabled || SEVERITY_RANK[notice.severity] < SEVERITY_RANK[preferences.minimumSeverity] || (source === "event" && now - Date.parse(entry.createdAt) > 30_000)) return entry.id;
    let resolvedId = entry.id;
    setQueue((current) => {
      const existingIndex = current.findIndex((item) => item.notice.key === notice.key);
      if (existingIndex >= 0) {
        const existing = current[existingIndex]!;
        resolvedId = existing.id;
        const closingTimer = closeTimers.current.get(existing.id);
        if (closingTimer !== undefined) window.clearTimeout(closingTimer);
        closeTimers.current.delete(existing.id);
        const next = [...current];
        next[existingIndex] = {
          ...existing,
          notice,
          source,
          count: existing.count + 1,
          revision: existing.revision + 1,
          closing: false,
        };
        return next;
      }
      const next = [...current, { id: resolvedId, notice, source, count: 1, revision: 0, closing: false }];
      return next.length > MAX_QUEUED_NOTICES ? next.slice(next.length - MAX_QUEUED_NOTICES) : next;
    });
    return resolvedId;
  }, [preferences.enabled, preferences.minimumSeverity, preferencesReady, userId]);

  useEffect(() => {
    activeShow = enqueue;
    return () => {
      if (activeShow === enqueue) activeShow = null;
    };
  }, [enqueue]);

  const eventsEnabled = preferencesReady && isAdmin && Object.values(preferences.events).some(Boolean);
  const liveFeed = useLiveEventFeed({}, { enabled: eventsEnabled, limit: EVENT_DEDUPE_LIMIT });
  useEffect(() => {
    if (!eventsEnabled) return;
    for (const event of liveFeed.events) {
      if (seenEventIds.current.has(event.eventId)) continue;
      seenEventIds.current.add(event.eventId);
      if (seenEventIds.current.size > EVENT_DEDUPE_LIMIT) seenEventIds.current.delete(seenEventIds.current.keys().next().value!);
      const notice = noticeForLiveEvent(event, preferences);
      if (notice) enqueue(notice, "event");
    }
  }, [enqueue, eventsEnabled, liveFeed.events, preferences]);

  const dismiss = useCallback((id: string) => {
    setQueue((current) => current.map((item) => item.id === id ? { ...item, closing: true } : item));
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const timer = window.setTimeout(() => {
      setQueue((current) => current.filter((item) => item.id !== id));
      closeTimers.current.delete(id);
    }, reducedMotion ? 0 : 180);
    closeTimers.current.set(id, timer);
  }, []);

  const savePreferences = useCallback(async (next: NotificationPreferences) => {
    if (!userId || typeof api.saveUiPreferences !== "function") throw new Error("Notification preferences are unavailable");
    setSavingPreferences(true);
    try {
      await api.saveUiPreferences(userId, { notifications: next });
      setPreferences(next);
      setPreferencesError(false);
    } finally {
      setSavingPreferences(false);
    }
  }, [userId]);

  const contextValue = useMemo<NotificationContextValue>(() => ({
    historyVersion,
    historyError,
    preferences,
    preferencesReady,
    preferencesError,
    savingPreferences,
    show: enqueue,
    run: (work, outcome) => runWith(enqueue, work, outcome),
    savePreferences,
  }), [enqueue, historyVersion, historyError, preferences, preferencesError, preferencesReady, savePreferences, savingPreferences]);

  const visible = queue.slice(0, preferences.maxVisible);
  return (
    <NotificationContext.Provider value={contextValue}>
      <div
        className="tantalar-notice-viewport"
        data-corner={preferences.corner}
        data-live={eventsEnabled ? liveFeed.status : undefined}
        role="region"
        aria-label="Notifications"
      >
        {visible.map((item) => (
          <NoticeCard
            key={item.id}
            item={item}
            durationMs={item.notice.durationMs === undefined ? preferences.durations[item.notice.severity] : item.notice.durationMs}
            onDismiss={() => dismiss(item.id)}
            onActivate={() => {
              if (item.notice.route) navigate(item.notice.route);
              dismiss(item.id);
            }}
          />
        ))}
      </div>
      {children}
    </NotificationContext.Provider>
  );
}

export function NotificationsPage({ isAdmin }: { readonly isAdmin: boolean }) {
  const { historyVersion, historyError } = useNotifications();
  const userId = useContext(CollectionUserContext);
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<string | null>("history");
  const [query, setQuery] = useState<ExplorerQuery>({ page: 1, pageSize: 25, search: "", filters: {}, sort: "createdAt", desc: true });
  const history = useQuery({ queryKey: ["notification-history", userId, query], queryFn: () => api.notificationHistory(query), enabled: tab === "history", placeholderData: previous => previous });
  useEffect(() => { void queryClient.invalidateQueries({ queryKey: ["notification-history", userId] }); }, [historyVersion, queryClient, userId]);
  return <Stack gap="md">
    <Title order={1}>Notifications</Title>
    <Tabs value={tab} onChange={setTab}>
      <Tabs.List><Tabs.Tab value="history">History</Tabs.Tab><Tabs.Tab value="settings">Settings</Tabs.Tab></Tabs.List>
      <Tabs.Panel value="history" pt="md">
        <Stack gap="sm">
          {historyError ? <Text role="alert" size="sm">Some notifications could not be saved.</Text> : null}
          {history.isError ? <Group><Text role="alert">Notification history could not be loaded.</Text><Button variant="default" onClick={() => void history.refetch()}>Retry</Button></Group> : null}
          <DenseGrid<NotificationHistoryEntry> testId="notification-history" ariaLabel="Notification history" data={history.data?.items ?? []} total={history.data?.total ?? 0} onQueryChange={setQuery} loading={history.isPending} emptyMessage="No notifications yet." filters={[{ id: "severity", label: "Severity", options: ["success", "warning", "error"].map(value => ({ value, label: value[0]!.toUpperCase() + value.slice(1) })) }]} columns={[
            { id: "title", header: "Notification", accessorKey: "title" },
            { id: "severity", header: "Severity", accessorKey: "severity", cell: ({ row }) => row.original.severity[0]!.toUpperCase() + row.original.severity.slice(1), meta: { compact: true } },
            { id: "message", header: "Details", accessorKey: "message" },
            { id: "createdAt", header: "Received", accessorKey: "createdAt", cell: ({ row }) => formatDateTime(row.original.createdAt) },
            { id: "count", header: "Count", accessorKey: "count", meta: { secondary: true, dataType: "number" } },
          ]} />
        </Stack>
      </Tabs.Panel>
      <Tabs.Panel value="settings" pt="md"><NotificationPreferencesPage isAdmin={isAdmin} /></Tabs.Panel>
    </Tabs>
  </Stack>;
}

export function NotificationPreferencesPage({ isAdmin }: { readonly isAdmin: boolean }) {
  const {
    preferences,
    preferencesReady,
    preferencesError,
    run: runNotice,
    savePreferences,
    savingPreferences,
  } = useNotifications();
  const [draft, setDraft] = useState(preferences);
  useEffect(() => setDraft(preferences), [preferences]);

  const setDuration = (severity: NoticeSeverity, seconds: string | number) => {
    const parsed = typeof seconds === "number" ? seconds : Number(seconds);
    setDraft((current) => ({
      ...current,
      durations: {
        ...current.durations,
        [severity]: boundedInteger(parsed, current.durations[severity] / 1_000, 1, 300) * 1_000,
      },
    }));
  };

  return (
    <Stack gap="lg" className="tantalar-notification-settings">
      {!preferencesReady ? <Text role="status">Loading notification preferences…</Text> : null}
      {preferencesReady && preferencesError ? (
        <Text role="alert" c="var(--tantalar-color-danger)">Saved preferences could not be loaded. Defaults are active.</Text>
      ) : null}
      {preferencesReady ? <Paper component="form" withBorder p="lg" autoComplete="off" aria-busy={savingPreferences} onSubmit={(event) => {
        event.preventDefault();
        void runNotice(() => savePreferences(draft), {
          success: { key: "notifications.preferences.saved", severity: "success", title: "Notification preferences saved" },
          error: { key: "notifications.preferences.failed", severity: "error", title: "Preferences were not saved", message: "Try again." },
        }).catch(() => undefined);
      }}>
        <fieldset className="tantalar-notification-settings__fields" disabled={savingPreferences}>
          <Stack gap="lg">
            <Switch
              name="notifications-enabled"
              checked={draft.enabled}
              label="Show in-app notifications"
              onChange={(event) => { const enabled = event.currentTarget.checked; setDraft(current => ({ ...current, enabled })); }}
            />
            <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="md" verticalSpacing="md">
              <NativeSelect
                name="notifications-position"
                label="Position"
                value={draft.corner}
                data={[
                  { value: "top-left", label: "Top left" },
                  { value: "top-right", label: "Top right" },
                  { value: "bottom-left", label: "Bottom left" },
                  { value: "bottom-right", label: "Bottom right" },
                ]}
                onChange={(event) => { const corner = event.currentTarget.value as NotificationCorner; setDraft(current => ({ ...current, corner })); }}
              />
              <NumberInput
                name="notifications-maximum-visible"
                label="Maximum visible"
                value={draft.maxVisible}
                min={1}
                max={5}
                allowDecimal={false}
                onChange={(value) => setDraft((current) => ({ ...current, maxVisible: boundedInteger(value, current.maxVisible, 1, 5) }))}
              />
              <NativeSelect
                name="notifications-minimum-severity"
                label="Minimum severity"
                value={draft.minimumSeverity}
                data={[
                  { value: "success", label: "Success" },
                  { value: "warning", label: "Warning" },
                  { value: "error", label: "Error" },
                ]}
                onChange={(event) => { const minimumSeverity = event.currentTarget.value as NoticeSeverity; setDraft(current => ({ ...current, minimumSeverity })); }}
              />
            </SimpleGrid>

            <section aria-labelledby="notification-duration-heading">
              <Title order={2} id="notification-duration-heading" size="h4">Display duration</Title>
              <Text size="sm" c="dimmed" mb="sm">Seconds before an unpaused notice closes.</Text>
              <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="md" verticalSpacing="md">
                {(["success", "warning", "error"] as const).map((severity) => (
                  <NumberInput
                    key={severity}
                    name={`notifications-${severity}-duration`}
                    label={`${severity[0]!.toUpperCase()}${severity.slice(1)} seconds`}
                    value={draft.durations[severity] / 1_000}
                    min={1}
                    max={300}
                    allowDecimal={false}
                    onChange={(value) => setDuration(severity, value)}
                  />
                ))}
              </SimpleGrid>
            </section>

            <section aria-labelledby="notification-event-heading">
              <Title order={2} id="notification-event-heading" size="h4">Operational events</Title>
              {isAdmin ? (
                <Stack gap="xs" mt="sm">
                  {([
                    ["downloads", "Downloads"],
                    ["imports", "Imports"],
                    ["plugins", "Plugins"],
                    ["vpn", "VPN"],
                    ["indexers", "Indexers"],
                  ] as const).map(([key, label]) => (
                    <Switch
                      key={key}
                      name={`notifications-events-${key}`}
                      checked={draft.events[key]}
                      label={label}
                      onChange={(event) => { const checked = event.currentTarget.checked; setDraft((current) => ({
                        ...current,
                        events: { ...current.events, [key]: checked },
                      })); }}
                    />
                  ))}
                </Stack>
              ) : (
                <Text size="sm" c="dimmed" mt="xs">Operational event notices require an administrator account.</Text>
              )}
            </section>
            <Group justify="flex-start">
              <Button type="submit" loading={savingPreferences}>Save preferences</Button>
            </Group>
          </Stack>
        </fieldset>
      </Paper> : null}
    </Stack>
  );
}
