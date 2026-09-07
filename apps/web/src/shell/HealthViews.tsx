import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Group, Skeleton, Stack, Text, Title } from "@mantine/core";
import { api, type DiagnosticsReport } from "../api";
import { formatBytes } from "../format-bytes";
import { CONTROL_AREAS, type ControlArea, type ControlChild } from "./ControlSurface";
import "./health.css";

type Navigate = (area: ControlArea, child?: ControlChild) => void;
type HealthTone = "healthy" | "degraded" | "blocked" | "unavailable";
type Action = {
  title: string;
  detail: string;
  area: ControlArea;
  child?: ControlChild;
  tone: Exclude<HealthTone, "healthy">;
};

function useDiagnostics() {
  return useQuery({
    queryKey: ["admin", "diagnostics", "snapshot"],
    queryFn: ({ signal }) => api.diagnostics({ signal }),
    retry: false,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
}

function formatDuration(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "Never";
}

function formatAgo(value: string | null): string {
  if (!value) return "never";
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 3_600) return `${Math.max(1, Math.floor(seconds / 60))}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

function humanize(value: string): string {
  const slug = value.split(".plugin.").at(-1) ?? value.replace(/^dev\.tantalar\.event\./, "");
  const acronyms: Record<string, string> = { api: "API", ffmpeg: "FFmpeg", mcp: "MCP", nntp: "NNTP", tmdb: "TMDB", tvdb: "TVDB", vpn: "VPN" };
  return slug.split(/[.-]/).map((part) => acronyms[part] ?? `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join(" ");
}

function overallTone(report: DiagnosticsReport): HealthTone {
  if (report.ready === null) return "unavailable";
  if (report.ready === false || report.missingCapabilities.length > 0) return "blocked";
  if (
    report.unavailable.length > 0
    || report.plugins.some((plugin) => !["healthy", "running"].includes(plugin.state))
    || (report.work.queue?.failed ?? 0) > 0
    || !report.transcoder.ffmpegAvailable
    || !report.capabilities.torrentEngineMounted
    || !report.capabilities.usenetEngineMounted
    || !report.capabilities.vpnMounted
  ) return "degraded";
  return "healthy";
}

function toneLabel(tone: HealthTone): string {
  return { healthy: "Healthy", degraded: "Needs attention", blocked: "Blocked", unavailable: "Unavailable" }[tone];
}

function requiredActions(report: DiagnosticsReport): Action[] {
  const actions: Action[] = [];
  if (report.ready !== true || report.missingCapabilities.length > 0) {
    actions.push({
      title: report.ready === null ? "Readiness could not be confirmed" : "Required services are not ready",
      detail: report.missingCapabilities.length > 0
        ? `Missing: ${report.missingCapabilities.join(", ")}`
        : "Open System Health for the current readiness evidence.",
      area: "system",
      child: "health",
      tone: report.ready === null ? "unavailable" : "blocked",
    });
  }
  const unhealthy = report.plugins.filter((plugin) => !["healthy", "running"].includes(plugin.state));
  if (unhealthy.length > 0) {
    actions.push({
      title: `${unhealthy.length} extension${unhealthy.length === 1 ? "" : "s"} need attention`,
      detail: unhealthy.map((plugin) => humanize(plugin.id)).join(", "),
      area: "extensions",
      tone: "degraded",
    });
  }
  if ((report.work.queue?.failed ?? 0) > 0) {
    actions.push({
      title: `${report.work.queue!.failed} acquisition job${report.work.queue!.failed === 1 ? " has" : "s have"} failed`,
      detail: "Review the failure reason before retrying.",
      area: "acquisition",
      child: "downloads",
      tone: "degraded",
    });
  }
  if (report.libraries.configured === 0) {
    actions.push({ title: "Add your first library", detail: "Tantalar has no media roots to scan.", area: "media", tone: "degraded" });
  }
  if (!report.transcoder.ffmpegAvailable) {
    actions.push({ title: "Install FFmpeg", detail: "Only directly compatible files can play without transcoding.", area: "playback", tone: "degraded" });
  }
  if (!report.capabilities.indexerMounted) {
    actions.push({ title: "Set up an indexer", detail: "Search is unavailable until an indexer module is mounted.", area: "acquisition", child: "indexers", tone: "degraded" });
  }
  const missingDownloaders = [
    !report.capabilities.usenetEngineMounted ? "Usenet" : null,
    !report.capabilities.torrentEngineMounted ? "Torrent" : null,
  ].filter((name): name is string => name !== null);
  if (missingDownloaders.length > 0) {
    actions.push({
      title: `${missingDownloaders.join(" and ")} downloader${missingDownloaders.length === 1 ? " is" : "s are"} not mounted`,
      detail: "Enable the modules in the host configuration, then restart Tantalar.",
      area: "acquisition",
      child: report.capabilities.usenetEngineMounted ? "torrent" : "usenet",
      tone: "degraded",
    });
  }
  if (!report.capabilities.vpnMounted) {
    actions.push({ title: "Review network protection", detail: "VPN-bound acquisition is not available.", area: "acquisition", child: "vpn", tone: "degraded" });
  }
  if (report.recentIncidents.length > 0) {
    actions.push({ title: "Review recent incidents", detail: `${report.recentIncidents.length} recent incidents`, area: "audit", child: "log", tone: "degraded" });
  }
  if (report.unavailable.length > 0) {
    actions.push({ title: "Some diagnostics are unavailable", detail: report.unavailable.join(" "), area: "system", child: "health", tone: "unavailable" });
  }
  return actions;
}

function Status({ tone, children }: { tone: HealthTone; children?: string }) {
  return <span className={`health-status health-status--${tone}`}>{children ?? toneLabel(tone)}</span>;
}

function LoadingHealth() {
  return (
    <Stack gap="lg" role="status" aria-label="Loading system status">
      <Skeleton height={84} radius="md" />
      <Skeleton height={92} radius="md" />
      <Skeleton height={210} radius="md" />
    </Stack>
  );
}

function LoadFailure({ retry, message }: { retry: () => void; message: string }) {
  return (
    <Alert color="red" title="Could not load system status">
      <Group justify="space-between" align="center">
        <Text size="sm">{message}</Text>
        <Button variant="default" onClick={retry}>Retry</Button>
      </Group>
    </Alert>
  );
}

/** Worst queue-action tone per area, so tiles and the queue can never disagree. */
function worstAreaTones(actions: readonly Action[]): Partial<Record<ControlArea, Action["tone"]>> {
  const rank = { blocked: 0, unavailable: 1, degraded: 2 } as const;
  const worst: Partial<Record<ControlArea, Action["tone"]>> = {};
  for (const action of actions) {
    const current = worst[action.area];
    if (!current || rank[action.tone] < rank[current]) worst[action.area] = action.tone;
  }
  return worst;
}

/** One truthful facts line per Control area, all from the shared snapshot. */
function areaFacts(report: DiagnosticsReport): Record<Exclude<ControlArea, "overview">, string> {
  const { libraries, work } = report;
  const queue = work.queue;
  const unhealthy = report.plugins.filter((plugin) => !["healthy", "running"].includes(plugin.state)).length;
  const incidents = report.recentIncidents.length;
  return {
    media: libraries.configured === null
      ? libraries.unavailableReason ?? "Library counts are unavailable"
      : `${libraries.configured} ${libraries.configured === 1 ? "library" : "libraries"} · ${libraries.catalog ? `${libraries.catalog.items} titles` : "catalog unavailable"} · scanned ${formatAgo(libraries.lastScanAt)}`,
    acquisition: queue
      ? `${queue.downloading} downloading · ${queue.queued} queued · ${queue.failed} failed`
      : work.queueUnavailableReason ?? "Queue state is unavailable",
    integrations: "API keys, webhooks and MCP",
    jobs: "Schedules, run history and file maintenance",
    extensions: report.plugins.length === 0
      ? "No extensions mounted"
      : `${report.plugins.length} mounted · ${unhealthy === 0 ? "all running" : `${unhealthy} not running`}`,
    people: "Users, roles and library access",
    playback: [
      work.activeStreams === null ? "Streams unavailable" : `${work.activeStreams} active ${work.activeStreams === 1 ? "stream" : "streams"}`,
      work.activeTranscodes === null ? "transcodes unavailable" : `${work.activeTranscodes} transcoding`,
      report.transcoder.ffmpegAvailable ? "FFmpeg available" : "FFmpeg missing",
    ].join(" · "),
    audit: report.eventCount === null
      ? "Event history is unavailable"
      : `${report.eventCount} recorded events${incidents > 0 ? ` · ${incidents} recent ${incidents === 1 ? "incident" : "incidents"}` : ""}`,
    system: `Up ${formatDuration(report.resources.uptimeSeconds)} · ${report.versions.tantalar.label}`,
  };
}

function ActivityItem({ label, value, detail, open }: { label: string; value: string; detail?: string; open: () => void }) {
  return (
    <button type="button" className="health-activity__item" onClick={open}>
      <span className="health-activity__label">{label}</span>
      <span className="health-activity__value">{value}</span>
      {detail ? <span className="health-activity__detail">{detail}</span> : null}
    </button>
  );
}

function ActionList({ actions, onNavigate }: { actions: readonly Action[]; onNavigate: Navigate }) {
  if (actions.length === 0) {
    return <div className="health-all-clear"><Status tone="healthy" /> No operator action is required.</div>;
  }
  return (
    <ol className="health-actions">
      {actions.map((action) => (
        <li key={`${action.area}:${action.child ?? ""}:${action.title}`}>
          <div><strong>{action.title}</strong><span>{action.detail}</span></div>
          <button type="button" aria-label={`${action.title}: open`} onClick={() => onNavigate(action.area, action.child)}>Review</button>
        </li>
      ))}
    </ol>
  );
}

export function OverviewDashboard({ onNavigate }: { onNavigate: Navigate }) {
  const query = useDiagnostics();
  if (query.isPending) return <LoadingHealth />;
  if (query.isError) return <LoadFailure message={(query.error as Error).message} retry={() => void query.refetch()} />;

  const report = query.data;
  const tone = overallTone(report);
  const actions = requiredActions(report);
  const facts = areaFacts(report);
  const worst = worstAreaTones(actions);
  const queue = report.work.queue;
  return (
    <div className="health-overview" data-testid="control-overview-dashboard">
      <header className="health-overview-toolbar">
        <Title order={1}>Overview</Title>
        <div className="health-overview-toolbar__controls">
        <div className="health-overview-toolbar__state">
          <Status tone={tone} />
          <Text size="sm" c="var(--tantalar-color-text-dimmed)">
            Updated {new Date(query.dataUpdatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </Text>
        </div>
        <Button variant="default" size="xs" aria-label="Refresh overview" onClick={() => void query.refetch()}>Refresh</Button>
        </div>
      </header>

      <section className="health-activity" aria-labelledby="overview-activity-heading">
        <div className="health-section-heading">
          <Title order={2} id="overview-activity-heading">Active work</Title>
        </div>
        <div className="health-activity__strip">
          <ActivityItem
            label="Downloading"
            value={queue ? String(queue.downloading) : "Unavailable"}
            detail={queue ? `${queue.queued} queued · ${queue.failed} failed` : report.work.queueUnavailableReason ?? undefined}
            open={() => onNavigate("acquisition", "downloads")}
          />
          <ActivityItem
            label="Streams"
            value={report.work.activeStreams === null ? "Unavailable" : String(report.work.activeStreams)}
            detail={report.work.activeStreams === null ? report.work.activeStreamsReason ?? undefined : "Serving now"}
            open={() => onNavigate("playback")}
          />
          <ActivityItem
            label="Transcodes"
            value={report.work.activeTranscodes === null ? "Unavailable" : String(report.work.activeTranscodes)}
            detail={report.work.activeTranscodes === null ? report.work.activeTranscodesReason ?? undefined : "FFmpeg workers"}
            open={() => onNavigate("playback")}
          />
          <ActivityItem
            label="Last library scan"
            value={formatAgo(report.libraries.lastScanAt)}
            detail={report.libraries.lastScanAt ? formatDate(report.libraries.lastScanAt) : "No completed scan recorded"}
            open={() => onNavigate("media")}
          />
        </div>
      </section>

      <div className="health-overview__columns">
      <section className="health-priorities" aria-labelledby="overview-actions-heading">
        <div className="health-section-heading">
          <div>
            <Title order={2} id="overview-actions-heading">{actions.length === 0 ? "All clear" : "Needs attention"}</Title>
            <Text size="sm" c="var(--tantalar-color-text-dimmed)">
              {actions.length === 0 ? "No action is required." : `${actions.length} open`}
            </Text>
          </div>
        </div>
        <ActionList actions={actions.slice(0, 5)} onNavigate={onNavigate} />
        {actions.length > 5 ? <button type="button" className="health-text-action" onClick={() => onNavigate("system", "health")}>View all {actions.length} checks</button> : null}
      </section>

      <aside className="health-host" aria-labelledby="overview-host-heading">
        <div className="health-section-heading"><Title order={2} id="overview-host-heading">Host</Title><button type="button" onClick={() => onNavigate("system", "health")}>Diagnostics</button></div>
        <dl>
          <div><dt>Version</dt><dd>{report.versions.tantalar.label}</dd></div>
          <div><dt>Uptime</dt><dd>{formatDuration(report.resources.uptimeSeconds)}</dd></div>
          <div><dt>Libraries</dt><dd>{report.libraries.configured ?? "Unavailable"}</dd></div>
          <div><dt>Catalog</dt><dd>{report.libraries.catalog ? `${report.libraries.catalog.items} titles` : "Unavailable"}</dd></div>
        </dl>
      </aside>
      </div>

      <section className="health-directory" aria-labelledby="overview-directory-heading">
        <div className="health-section-heading">
          <Title order={2} id="overview-directory-heading">Services</Title>
        </div>
        <div className="health-directory__grid">
          {CONTROL_AREAS.filter((area) => area.value !== "overview").map((area) => {
            const AreaIcon = area.icon;
            const fault = worst[area.value];
            const detail = facts[area.value as Exclude<ControlArea, "overview">];
            return (
              <button
                key={area.value}
                type="button"
                className="health-tile"
                data-testid={`overview-tile-${area.value}`}
                onClick={() => onNavigate(area.value)}
              >
                <span className="health-tile__title">
                  <AreaIcon className="tantalar-nav-icon" fill="currentColor" aria-hidden="true" />
                  <strong>{area.label}</strong>
                  {fault ? <Status tone={fault} /> : null}
                </span>
                <span className="health-tile__facts" title={detail}>{detail}</span>
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function HealthTableHeader() {
  return (
    <div className="health-table__header" role="row">
      <span role="columnheader">Name</span>
      <span role="columnheader">Detail</span>
      <span role="columnheader">Value or status</span>
      <span role="columnheader">Action</span>
    </div>
  );
}

function HealthRow({ label, value, detail, tone = "healthy", kind = "value", action }: {
  label: string;
  value: string;
  detail?: React.ReactNode;
  tone?: HealthTone;
  kind?: "value" | "status";
  action?: { label: string; run: () => void };
}) {
  return (
    <div className="health-table__row" role="row" data-testid="health-row">
      <strong className="health-table__name" role="cell">{label}</strong>
      <div className="health-table__detail" role="cell">{detail ?? <span aria-hidden="true">—</span>}</div>
      <div className="health-table__value" role="cell">
        {kind === "status" ? <Status tone={tone}>{value}</Status> : <span data-tone={tone}>{value}</span>}
      </div>
      <div className="health-table__action" role="cell">
        {action ? <button type="button" onClick={action.run}>{action.label}</button> : <span aria-hidden="true">—</span>}
      </div>
    </div>
  );
}

function HealthGroup({ title, summary, children }: { title: string; summary: string; children: React.ReactNode }) {
  return (
    <section className="health-table-section" aria-labelledby={`health-${title.toLowerCase().replace(/[^a-z]+/g, "-")}`}>
      <header className="health-table-section__heading">
        <Title order={3} id={`health-${title.toLowerCase().replace(/[^a-z]+/g, "-")}`}>{title}</Title>
        <Text size="xs" c="var(--tantalar-color-text-dimmed)">{summary}</Text>
      </header>
      <div className="health-table" role="table" aria-label={title}>
        <HealthTableHeader />
        <div role="rowgroup">{children}</div>
      </div>
    </section>
  );
}

function ProblemsTable({ actions, onNavigate }: { actions: readonly Action[]; onNavigate: Navigate }) {
  const sorted = [...actions].sort((a, b) => ({ blocked: 0, unavailable: 1, degraded: 2 }[a.tone] - { blocked: 0, unavailable: 1, degraded: 2 }[b.tone]));
  return (
    <section className="health-table-section health-problems" aria-labelledby="health-problems-heading">
      <header className="health-table-section__heading">
        <Title order={3} id="health-problems-heading">Problems</Title>
        <Text size="xs" c="var(--tantalar-color-text-dimmed)">{sorted.length === 0 ? "No current problems." : `${sorted.length} item${sorted.length === 1 ? "" : "s"}, highest impact first.`}</Text>
      </header>
      <div className="health-table" role="table" aria-label="Problems">
        <HealthTableHeader />
        <div role="rowgroup">
          {sorted.length === 0 ? (
            <div className="health-table__empty" role="row"><span role="cell">No operator action is required.</span></div>
          ) : sorted.map((action) => (
            <div className="health-table__row" role="row" data-testid="health-problem-row" key={`${action.area}:${action.child ?? ""}:${action.title}`}>
              <strong className="health-table__name" role="cell">{action.title}</strong>
              <div className="health-table__detail" role="cell">{action.detail}</div>
              <div className="health-table__value" role="cell"><Status tone={action.tone} /></div>
              <div className="health-table__action" role="cell"><button type="button" onClick={() => onNavigate(action.area, action.child)}>Open</button></div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export function SystemHealthDashboard({ onNavigate }: { onNavigate: Navigate }) {
  const query = useDiagnostics();
  if (query.isPending) return <LoadingHealth />;
  if (query.isError) return <LoadFailure message={(query.error as Error).message} retry={() => void query.refetch()} />;

  const report = query.data;
  const tone = overallTone(report);
  const actions = requiredActions(report);
  const volume = report.storage.dataVolume;
  const pluginTone = (state: string): HealthTone => ["healthy", "running"].includes(state) ? "healthy" : state === "failed" ? "blocked" : "degraded";
  return (
    <Stack gap="md" className="system-health-console" data-testid="system-health-dashboard">
      <div className="health-toolbar" data-testid="health-toolbar">
        <div className="health-toolbar__state">
          <span>Overall</span>
          <Status tone={tone} />
          <small>{actions.length === 0 ? "No operator action required" : `${actions.length} problem${actions.length === 1 ? "" : "s"}`}</small>
        </div>
        <Button variant="default" size="compact-xs" onClick={() => void query.refetch()}>Refresh checks</Button>
      </div>

      <ProblemsTable actions={actions} onNavigate={onNavigate} />

      <div className="health-groups">
        <HealthGroup title="Resources" summary="Current host and Tantalar process snapshot.">
          <HealthRow label="Server uptime" value={formatDuration(report.resources.uptimeSeconds)} detail={`Started ${formatDate(report.resources.startedAt)}`} />
          <HealthRow label="Process memory" value={formatBytes(report.resources.process.rssBytes)} detail={`${formatBytes(report.resources.process.heapUsedBytes)} heap`} />
          <HealthRow label="Host memory" value={formatBytes(report.resources.host.usedMemoryBytes)} detail={`${formatBytes(report.resources.host.freeMemoryBytes)} available of ${formatBytes(report.resources.host.totalMemoryBytes)}`} />
          <HealthRow label="Host load" value={report.resources.host.loadAverage[0]?.toFixed(2) ?? "Unavailable"} detail="1 minute average" tone={report.resources.host.loadAverage[0] === undefined ? "unavailable" : "healthy"} kind={report.resources.host.loadAverage[0] === undefined ? "status" : "value"} />
        </HealthGroup>

        <HealthGroup title="Storage and libraries" summary="Data-volume capacity and durable catalog counts.">
          <HealthRow label="Tantalar data volume" value={formatBytes(volume.usedBytes)} detail={volume.unavailableReason ?? `${formatBytes(volume.freeBytes)} free of ${formatBytes(volume.totalBytes)}`} tone={volume.usedBytes === null ? "unavailable" : "healthy"} kind={volume.usedBytes === null ? "status" : "value"} />
          <HealthRow label="Configured libraries" value={report.libraries.configured === null ? "Unavailable" : String(report.libraries.configured)} detail={report.libraries.byKind ? `${report.libraries.byKind.movie} movie · ${report.libraries.byKind.series} series · ${report.libraries.byKind.mixed} mixed` : report.libraries.unavailableReason ?? undefined} tone={report.libraries.configured === null ? "unavailable" : report.libraries.configured === 0 ? "degraded" : "healthy"} kind={report.libraries.configured === null ? "status" : "value"} action={{ label: "Manage", run: () => onNavigate("media") }} />
          <HealthRow label="Catalog" value={report.libraries.catalog ? `${report.libraries.catalog.items} titles` : "Unavailable"} detail={report.libraries.catalog ? `${report.libraries.catalog.files} files` : report.libraries.unavailableReason ?? undefined} tone={report.libraries.catalog ? "healthy" : "unavailable"} kind={report.libraries.catalog ? "value" : "status"} />
          <HealthRow label="Known media size" value="Unavailable" detail={report.storage.catalogKnownBytesReason} tone="unavailable" kind="status" />
          <HealthRow label="Last library scan" value={formatDate(report.libraries.lastScanAt)} tone={report.libraries.lastScanAt ? "healthy" : "degraded"} />
        </HealthGroup>

        <HealthGroup title="Media pipeline" summary="Playback dependencies and durable playback evidence.">
          <HealthRow label="FFmpeg transcoding" value={report.transcoder.ffmpegAvailable ? "Available" : "Missing"} detail={report.transcoder.ffmpegAvailable ? "Transcoding can be started when required." : "Only directly compatible files can play."} tone={report.transcoder.ffmpegAvailable ? "healthy" : "blocked"} kind="status" action={{ label: "Manage", run: () => onNavigate("playback") }} />
          <HealthRow label="Playback starts" value={report.work.playbackStarts === null ? "Unavailable" : String(report.work.playbackStarts)} detail="Durable lifetime count" tone={report.work.playbackStarts === null ? "unavailable" : "healthy"} kind={report.work.playbackStarts === null ? "status" : "value"} />
          <HealthRow label="Active streams" value={report.work.activeStreams === null ? "Unavailable" : String(report.work.activeStreams)} detail={report.work.activeStreamsReason ?? "Current serving sessions"} tone={report.work.activeStreams === null ? "unavailable" : "healthy"} kind={report.work.activeStreams === null ? "status" : "value"} action={{ label: "Manage", run: () => onNavigate("playback") }} />
          <HealthRow label="Active transcodes" value={report.work.activeTranscodes === null ? "Unavailable" : String(report.work.activeTranscodes)} detail={report.work.activeTranscodesReason ?? "Current FFmpeg workers"} tone={report.work.activeTranscodes === null ? "unavailable" : "healthy"} kind={report.work.activeTranscodes === null ? "status" : "value"} action={{ label: "Manage", run: () => onNavigate("playback") }} />
        </HealthGroup>

        <HealthGroup title="Acquisition and network" summary="Queue state and mounted search, download and protection capabilities.">
          <HealthRow label="Download queue" value={report.work.queue ? `${report.work.queue.downloading} active` : "Unavailable"} detail={report.work.queue ? `${report.work.queue.queued} queued · ${report.work.queue.paused} paused · ${report.work.queue.failed} failed` : report.work.queueUnavailableReason ?? undefined} tone={!report.work.queue ? "unavailable" : report.work.queue.failed > 0 ? "degraded" : "healthy"} kind={report.work.queue ? "value" : "status"} action={{ label: "Open queue", run: () => onNavigate("acquisition", "downloads") }} />
          <HealthRow label="Indexers" value={report.capabilities.indexerMounted ? "Mounted" : "Not mounted"} tone={report.capabilities.indexerMounted ? "healthy" : "blocked"} kind="status" action={{ label: "Configure", run: () => onNavigate("acquisition", "indexers") }} />
          <HealthRow label="Native torrent" value={report.capabilities.torrentEngineMounted ? "Mounted" : "Not mounted"} detail="Mounted does not imply configured or network-ready." tone={report.capabilities.torrentEngineMounted ? "healthy" : "blocked"} kind="status" action={{ label: "Configure", run: () => onNavigate("acquisition", "torrent") }} />
          <HealthRow label="Native Usenet" value={report.capabilities.usenetEngineMounted ? "Mounted" : "Not mounted"} detail="Mounted does not imply configured or account-ready." tone={report.capabilities.usenetEngineMounted ? "healthy" : "blocked"} kind="status" action={{ label: "Configure", run: () => onNavigate("acquisition", "usenet") }} />
          <HealthRow label="VPN binding" value={report.capabilities.vpnMounted ? "Mounted" : "Not mounted"} detail="This reports capability presence, not tunnel enforcement." tone={report.capabilities.vpnMounted ? "healthy" : "blocked"} kind="status" action={{ label: "Review", run: () => onNavigate("acquisition", "vpn") }} />
        </HealthGroup>

        <HealthGroup title="Extensions" summary="Human names first; technical identities remain available on demand.">
          {report.plugins.length === 0 ? <HealthRow label="Mounted extensions" value="None" tone="blocked" kind="status" action={{ label: "Extensions", run: () => onNavigate("extensions") }} /> : report.plugins.map((plugin) => (
            <HealthRow
              key={plugin.id}
              label={humanize(plugin.id)}
              value={humanize(plugin.state)}
              tone={pluginTone(plugin.state)}
              kind="status"
              action={{ label: "Manage", run: () => onNavigate("extensions") }}
              detail={(
                <div className="health-extension-detail">
                  <span>{plugin.restarts} restart{plugin.restarts === 1 ? "" : "s"}</span>
                  <details><summary>Technical details</summary><code>{plugin.id}</code><span>v{plugin.version}</span><span>{plugin.provides.join(", ") || "No declared capabilities"}</span></details>
                </div>
              )}
            />
          ))}
        </HealthGroup>

        <HealthGroup title="Recent incidents" summary="Latest durable plugin, download, import and browser-client failures.">
          {report.incidentsUnavailableReason ? <HealthRow label="Incident history" value="Unavailable" detail={report.incidentsUnavailableReason} tone="unavailable" kind="status" /> : report.recentIncidents.length === 0 ? <HealthRow label="Incident history" value="Clear" detail="No recent incident records were found." kind="status" /> : report.recentIncidents.map((incident) => (
            <HealthRow key={incident.id} label={humanize(incident.type)} value="Incident" detail={`${incident.subject ?? "No affected subject recorded"} · ${formatDate(incident.occurredAt)}`} tone="degraded" kind="status" action={{ label: "Audit", run: () => onNavigate("audit", "log") }} />
          ))}
        </HealthGroup>
      </div>

      <details className="health-advanced">
        <summary>Advanced diagnostics</summary>
        <div className="health-table" role="table" aria-label="Advanced diagnostics">
          <HealthTableHeader />
          <div role="rowgroup">
            <HealthRow label="Tantalar" value={report.versions.tantalar.label} detail={report.versions.tantalar.version} />
            <HealthRow label="Runtime" value={report.versions.node} detail={`${report.versions.platform} · ${report.versions.arch}`} />
            <HealthRow label="Recorded events" value={report.eventCount === null ? "Unavailable" : String(report.eventCount)} tone={report.eventCount === null ? "unavailable" : "healthy"} />
            <HealthRow label="Missing capabilities" value={report.missingCapabilities.length === 0 ? "None" : String(report.missingCapabilities.length)} detail={report.missingCapabilities.join(", ") || undefined} tone={report.missingCapabilities.length === 0 ? "healthy" : "blocked"} />
          </div>
        </div>
      </details>
    </Stack>
  );
}
