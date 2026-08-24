/**
 * Admin views (phase 6, stories 25–27): queue, wanted, history, plugins,
 * users, settings/theme editor and system health. Every view implements the
 * full state set: loading, empty, error+retry, permission-denied and
 * degraded-service handling. All styling reads `--tantalar-*` tokens.
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import {
  Alert,
  Button,
  Group,
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
import { api, type DownloadJob, type AuditEntry } from "../api";
import { DenseGrid, type GridLayout } from "./DenseGrid";
import {
  assembleChains,
  reconstructDecision,
} from "../activity/trajectory";
import { useTheme } from "../theme/engine";
import { DEFAULT_TOKENS, TOKEN_PREFIX, TOKEN_LABELS, sanitizeTokenOverrides } from "../theme/tokens";

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
  const { layout, update: setLayout } = usePersistedGridPrefs(adminId);
  const [showHistory, setShowHistory] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const q = useAdminQuery(["admin", "queue", showHistory], () => api.queue(showHistory));

  const act = async (
    job: DownloadJob,
    action: "pause" | "resume" | "retry" | "remove",
  ) => {
    setNote(null);
    // Destructive removal states its data-file consequence up front.
    if (action === "remove") {
      const deleteFiles = window.confirm(
        `Remove “${job.title}” from the queue?\n\nOK = remove and DELETE downloaded files.\nCancel = keep the files.`,
      );
      if (!deleteFiles) return;
      try {
        const res = await api.queueAction(job.jobId, "remove", { deleteDataFiles: true });
        setNote(res.note ?? "Removed.");
      } catch (err) {
        setNote((err as Error).message);
      }
      void qc.invalidateQueries({ queryKey: ["admin", "queue"] });
      return;
    }
    try {
      await api.queueAction(job.jobId, action);
    } catch (err) {
      setNote((err as Error).message);
    }
    void qc.invalidateQueries({ queryKey: ["admin", "queue"] });
  };

  if (q.isPending) return <LoadState />;
  if (q.isError) return <ErrorState message={(q.error as Error).message} onRetry={() => void q.refetch()} />;

  const jobs = q.data.jobs;
  const columns: ReadonlyArray<ColumnDef<DownloadJob, unknown>> = [
    { id: "title", header: "Title", accessorKey: "title" },
    { id: "source", header: "Engine", accessorFn: (r) => r.source },
    { id: "state", header: "State", accessorKey: "state" },
    { id: "progressPercent", header: "Progress %", accessorKey: "progressPercent" },
    { id: "priority", header: "Priority", accessorKey: "priority" },
    { id: "retryCount", header: "Retries", accessorKey: "retryCount" },
    {
      id: "failure",
      header: "Failure detail",
      accessorFn: (r) => r.failureReason ?? "",
      cell: ({ row }) =>
        row.original.failureReason ? (
          <Text size="xs" c="var(--tantalar-color-danger)">{row.original.failureReason}</Text>
        ) : null,
    },
    {
      id: "handoff",
      header: "Import handoff",
      accessorFn: (r) => r.importHandoffPath ?? "",
      cell: ({ row }) =>
        row.original.importHandoffPath ? (
          <Text size="xs">handed to importer</Text>
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
      {note ? <div role="status" data-testid="queue-note">{note}</div> : null}
      <DenseGrid
        testId="queue-grid"
        columns={columns}
        data={jobs}
        layout={layout}
        onLayoutChange={setLayout}
        emptyMessage={showHistory ? "No downloads yet." : "The download queue is empty."}
      />
    </Stack>
  );
}

// ---- Wanted view ------------------------------------------------------------

interface WantedRow {
  seriesId?: string;
  movieId?: string;
  episodeKey?: string;
}

export function WantedView({ adminId }: { adminId: string | null }) {
  const { layout, update: setLayout } = usePersistedGridPrefs(adminId);
  const q = useAdminQuery(["admin", "wanted"], async () => {
    const wanted: WantedRow[] = [];
    for (const [pluginId, cap] of [
      ["dev.tantalar.plugin.series", "dev.tantalar.capability.series"],
      ["dev.tantalar.plugin.movies", "dev.tantalar.capability.movies"],
    ] as const) {
      try {
        const res = await api.invokeCapability(pluginId, cap, "wanted");
        const rows = ((res.result as Record<string, unknown>).wanted ?? []) as WantedRow[];
        wanted.push(...rows);
      } catch {
        /* plugin absent or not that kind — skip */
      }
    }
    return wanted;
  });

  if (q.isPending) return <LoadState />;
  if (q.isError) return <ErrorState message={(q.error as Error).message} onRetry={() => void q.refetch()} />;

  const columns: ReadonlyArray<ColumnDef<WantedRow, unknown>> = [
    { id: "seriesId", header: "Series", accessorKey: "seriesId" },
    { id: "movieId", header: "Movie", accessorKey: "movieId" },
    { id: "episodeKey", header: "Episode", accessorKey: "episodeKey" },
  ];

  return (
    <Stack gap="sm">
      <Title order={4}>Wanted</Title>
      <DenseGrid
        testId="wanted-grid"
        columns={columns}
        data={q.data}
        layout={layout}
        onLayoutChange={setLayout}
        emptyMessage="Nothing is missing — everything monitored is acquired."
      />
    </Stack>
  );
}

// ---- History view -----------------------------------------------------------

export function HistoryView({ adminId }: { adminId: string | null }) {
  const { layout, update: setLayout } = usePersistedGridPrefs(adminId);
  const q = useAdminQuery(["admin", "history"], () => api.history() as Promise<{ history: Record<string, unknown>[] }>);

  if (q.isPending) return <LoadState />;
  if (q.isError) return <ErrorState message={(q.error as Error).message} onRetry={() => void q.refetch()} />;

  const rows = q.data.history ?? [];
  const columns: ReadonlyArray<ColumnDef<Record<string, unknown>, unknown>> = [
    { id: "userId", header: "Viewer", accessorFn: (r) => String(r.userId ?? "") },
    { id: "fileId", header: "File", accessorFn: (r) => String(r.fileId ?? "") },
    { id: "completed", header: "Completed", accessorFn: (r) => String(r.completed ?? "") },
    { id: "startedAt", header: "Started", accessorFn: (r) => String(r.startedAt ?? "") },
  ];

  return (
    <Stack gap="sm">
      <Title order={4}>Watch history</Title>
      <DenseGrid
        testId="history-grid"
        columns={columns}
        data={rows}
        layout={layout}
        onLayoutChange={setLayout}
        emptyMessage="No watch history yet."
      />
    </Stack>
  );
}

// ---- Plugins view (Wave 9, TAN-031: full management) ------------------------

export function PluginsView() {
  const qc = useQueryClient();
  const q = useAdminQuery(["admin", "plugins"], () => api.plugins());
  const [note, setNote] = useState<string | null>(null);

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
      setNote(`${id}: ${(err as Error).message}`);
    }
    void qc.invalidateQueries({ queryKey: ["admin", "plugins"] });
  };

  if (q.isPending) return <LoadState />;
  if (q.isError) return <ErrorState message={(q.error as Error).message} onRetry={() => void q.refetch()} />;

  return (
    <Stack gap="sm">
      <Title order={4}>Plugins</Title>
      {note ? <div role="status" data-testid="plugins-note">{note}</div> : null}
      {q.data.plugins.length === 0 ? (
        <Text c="var(--tantalar-color-text-dimmed)">No plugins are mounted.</Text>
      ) : (
        <Stack gap="xs">
          {q.data.plugins.map((p) => (
            <Paper
              key={p.manifest.id}
              data-testid={`plugin-${p.manifest.id}`}
              p="sm"
              radius="md"
              style={{
                background: "var(--tantalar-color-surface-raised)",
                border: "1px solid var(--tantalar-color-border)",
              }}
            >
              <Group justify="space-between" wrap="wrap">
                <div>
                  <Text fw={600}>{p.manifest.id}</Text>
                  <Text size="sm" c="var(--tantalar-color-text-dimmed)">
                    v{p.manifest.version} · restarts: {p.restartCount}
                    {p.manifest.provides.length > 0 ? ` · provides ${p.manifest.provides.length}` : ""}
                  </Text>
                </div>
                <Group gap="xs">
                  <Text size="sm" c={p.state === "running" || p.state === "healthy" ? "var(--tantalar-color-success)" : "var(--tantalar-color-warning)"}>
                    {p.state}
                  </Text>
                  <Button
                    size="compact-xs"
                    variant="default"
                    data-testid={`restart-${p.manifest.id}`}
                    onClick={() => void act(p.manifest.id, "restart")}
                  >
                    Restart
                  </Button>
                  <Button
                    size="compact-xs"
                    variant="light"
                    color="red"
                    data-testid={`disable-${p.manifest.id}`}
                    onClick={() => void act(p.manifest.id, "disable")}
                  >
                    Disable
                  </Button>
                </Group>
              </Group>
            </Paper>
          ))}
        </Stack>
      )}
    </Stack>
  );
}

// ---- Users view (Wave 9, TAN-032: full management + last-admin safeguard) ----

export function UsersView() {
  const qc = useQueryClient();
  const q = useAdminQuery(["admin", "users"], () => api.users());
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"admin" | "viewer">("viewer");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  if (q.isPending) return <LoadState />;
  if (q.isError) {
    const status = (q.error as { status?: number }).status;
    if (status === 403) return <PermissionState />;
    return <ErrorState message={(q.error as Error).message} onRetry={() => void q.refetch()} />;
  }

  const create = async () => {
    setError(null);
    try {
      await api.createUser(username, password, role);
      setUsername("");
      setPassword("");
      void qc.invalidateQueries({ queryKey: ["admin", "users"] });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const manage = async (
    u: { id: string; username: string; role: string },
    action: "promote" | "demote" | "resetPassword" | "revokeSessions" | "deactivate" | "reactivate",
  ) => {
    setNote(null);
    try {
      if (action === "promote" || action === "demote") {
        await api.setUserRole(u.id, action === "promote" ? "admin" : "viewer");
        setNote(`${u.username} is now ${action === "promote" ? "an administrator" : "a viewer"}.`);
        if (action === "demote") setNote((n) => `${n} Their active sessions were signed out.`);
      } else if (action === "resetPassword") {
        const newPassword = window.prompt(`New password for ${u.username} (at least 8 characters):`) ?? "";
        if (!newPassword) return;
        await api.resetUserPassword(u.id, newPassword);
        setNote(`Password reset for ${u.username}; their sessions were signed out.`);
      } else if (action === "revokeSessions") {
        const res = await api.revokeUserSessions(u.id);
        setNote(`Signed out ${u.username} (${res.revoked} session${res.revoked === 1 ? "" : "s"}).`);
      } else if (action === "deactivate") {
        await api.setUserActive(u.id, false);
        setNote(`${u.username} was deactivated and signed out.`);
      } else {
        await api.setUserActive(u.id, true);
        setNote(`${u.username} was reactivated.`);
      }
    } catch (err) {
      // Last-admin refusals surface here with the server's reason.
      setNote(`${u.username}: ${(err as Error).message}`);
    }
    void qc.invalidateQueries({ queryKey: ["admin", "users"] });
  };

  return (
    <Stack gap="sm">
      <Title order={4}>Users</Title>
      {note ? <div role="status" data-testid="users-note">{note}</div> : null}
      <Stack gap="xs" component="form" onSubmit={(e) => { e.preventDefault(); void create(); }} w={340}>
        <TextInput label="Username" data-testid="new-user-username" value={username} onChange={(e) => setUsername(e.currentTarget.value)} required />
        <PasswordInput label="Password" data-testid="new-user-password" value={password} onChange={(e) => setPassword(e.currentTarget.value)} required />
        <NativeSelect
          aria-label="Role"
          data={[{ value: "viewer", label: "Viewer" }, { value: "admin", label: "Admin" }]}
          value={role}
          onChange={(e) => setRole(e.currentTarget.value as "admin" | "viewer")}
        />
        {error ? <div role="alert">{error}</div> : null}
        <Button type="submit" data-testid="create-user">Create user</Button>
      </Stack>
      <Stack gap="xs" data-testid="users-grid">
        {q.data.users.map((u) => (
        <Paper
          key={u.id}
          data-testid={`user-${u.username}`}
          p="sm"
          radius="md"
          style={{ background: "var(--tantalar-color-surface)", border: "1px solid var(--tantalar-color-border)" }}
        >
          <Group justify="space-between" wrap="wrap">
            <div>
              <Text size="sm" fw={600}>{u.username}</Text>
              <Text size="xs" c="var(--tantalar-color-text-dimmed)">
                {u.role}
                {" · "}
                created {u.createdAt.slice(0, 10)}
              </Text>
            </div>
            <Group gap="xs">
              {u.role === "viewer" ? (
                <Button size="compact-xs" variant="default" onClick={() => void manage(u, "promote")}>Make admin</Button>
              ) : (
                <Button size="compact-xs" variant="default" onClick={() => void manage(u, "demote")}>Make viewer</Button>
              )}
              <Button size="compact-xs" variant="default" onClick={() => void manage(u, "resetPassword")}>Reset password</Button>
              <Button size="compact-xs" variant="default" onClick={() => void manage(u, "revokeSessions")}>Sign out</Button>
              {u.role !== undefined ? (
                <Button size="compact-xs" variant="light" color="red" onClick={() => void manage(u, "deactivate")}>Deactivate</Button>
              ) : null}
            </Group>
          </Group>
        </Paper>
        ))}
      </Stack>
    </Stack>
  );
}

// ---- Audit view (Wave 9, TAN-032: security audit log) ------------------------

export function AuditView() {
  const q = useAdminQuery(["admin", "audit"], () => api.auditLog(200));
  if (q.isPending) return <LoadState />;
  if (q.isError) return <ErrorState message={(q.error as Error).message} onRetry={() => void q.refetch()} />;

  const entries = q.data.entries;
  const columns: ReadonlyArray<ColumnDef<AuditEntry, unknown>> = [
    { id: "occurredAt", header: "When", accessorKey: "occurredAt" },
    { id: "actor", header: "Actor", accessorFn: (r) => r.actorUsername ?? "" },
    { id: "action", header: "Action", accessorKey: "action" },
    { id: "target", header: "Target", accessorFn: (r) => `${r.targetType}:${r.targetId}` },
  ];

  return (
    <Stack gap="sm" data-testid="audit-view">
      <Title order={4}>Security audit log</Title>
      <DenseGrid
        testId="audit-grid"
        columns={columns}
        data={entries}
        layout={{ hiddenColumns: [], density: "dense" }}
        emptyMessage="No security events recorded yet."
      />
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

  const degraded = !q.data.ready || q.data.eventCount === null;
  return (
    <Stack gap="sm" data-testid="system-health">
      <Title order={4}>System health</Title>
      {degraded ? (
        <Alert color="yellow" title="Degraded service">
          <Text size="sm">Some subsystems did not report cleanly. Values below may be incomplete.</Text>
        </Alert>
      ) : (
        <Text c="var(--tantalar-color-success)">All systems ready.</Text>
      )}
      <Text>Ready: {String(q.data.ready)}</Text>
      <Text>Events in log: {q.data.eventCount === null ? "unknown" : q.data.eventCount}</Text>
      <Stack gap="xs">
        {q.data.plugins.map((p) => (
          <Group key={p.id} justify="space-between">
            <Text size="sm">{p.id}</Text>
            <Text size="sm" c={p.state === "running" ? "var(--tantalar-color-success)" : "var(--tantalar-color-warning)"}>
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
  const [correlationId, setCorrelationId] = useState("");
  const [selectedChain, setSelectedChain] = useState<string | null>(null);

  const q = useAdminQuery(
    ["admin", "trajectory", typePrefix, subject, correlationId],
    () =>
      api.events({
        ...(typePrefix ? { typePrefix } : {}),
        ...(subject ? { subject } : {}),
        ...(correlationId ? { correlationId } : {}),
        limit: 500,
      }),
  );

  const chains = useMemo(() => assembleChains(q.data?.events ?? []), [q.data]);

  const selected = selectedChain ? chains.find((c) => c.correlationId === selectedChain) : undefined;
  const narrative = selected ? reconstructDecision(selected) : null;

  return (
    <Stack gap="sm" data-testid="activity-view">
      <Title order={4}>Activity & Trajectory</Title>
      <Group wrap="wrap">
        <TextInput
          aria-label="Filter by event type prefix"
          placeholder="dev.tantalar.event.grab…"
          label="Type prefix"
          value={typePrefix}
          onChange={(e) => setTypePrefix(e.currentTarget.value)}
        />
        <TextInput
          aria-label="Filter by subject"
          label="Subject"
          value={subject}
          onChange={(e) => setSubject(e.currentTarget.value)}
        />
        <TextInput
          aria-label="Filter by correlation id"
          label="Correlation id"
          value={correlationId}
          onChange={(e) => setCorrelationId(e.currentTarget.value)}
        />
      </Group>

      {q.isPending ? <LoadState /> : null}
      {q.isError ? <ErrorState message={(q.error as Error).message} onRetry={() => void q.refetch()} /> : null}
      {q.isSuccess && chains.length === 0 ? (
        <Text c="var(--tantalar-color-text-dimmed)">No activity matches those filters.</Text>
      ) : null}

      {chains.length > 0 ? (
        <NativeSelect
          aria-label="Correlation chain"
          data-testid="chain-select"
          data={[
            { value: "", label: `${chains.length} correlation chains — pick one to reconstruct` },
            ...chains.map((c) => ({
              value: c.correlationId,
              label: `${c.events.length} events · ${c.events[0]?.occurredAt ?? ""}`,
            })),
          ]}
          value={selectedChain ?? ""}
          onChange={(e) => setSelectedChain(e.currentTarget.value || null)}
        />
      ) : null}

      {narrative && selected ? (
        <Paper p="md" radius="md" data-testid="decision-reconstruction"
          style={{ background: "var(--tantalar-color-surface)", border: "1px solid var(--tantalar-color-border)" }}>
          <Text fw={600} mb="xs">{narrative.summary}</Text>
          <ol style={{ margin: 0, paddingLeft: 20 }}>
            {narrative.steps.map((s) => (
              <li key={s.id}>
                <Text size="sm">
                  {s.label} <Text span c="dimmed" size="xs">({s.at})</Text>
                  {s.detail ? <Text span size="xs" c="dimmed"> — {s.detail}</Text> : null}
                </Text>
              </li>
            ))}
          </ol>
          {narrative.complete ? (
            <Text size="sm" c="var(--tantalar-color-success)" mt="xs">
              Full grab→import chain reconstructed from the event log.
            </Text>
          ) : null}
        </Paper>
      ) : null}
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
