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
import { api } from "../api";
import { DenseGrid, type GridLayout } from "./DenseGrid";
import {
  assembleChains,
  reconstructDecision,
} from "../activity/trajectory";
import { useTheme } from "../theme/engine";
import { DEFAULT_TOKENS, TOKEN_PREFIX, sanitizeTokenOverrides } from "../theme/tokens";

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

// ---- Queue view -------------------------------------------------------------

interface DownloadRow {
  downloadId: string;
  itemKey: string;
  state: string;
  progressPercent: number;
}

const QUEUE_CAPABILITY = "dev.tantalar.capability.download-client";

export function QueueView({ adminId }: { adminId: string | null }) {
  const qc = useQueryClient();
  const { layout, update: setLayout } = usePersistedGridPrefs(adminId);
  const q = useAdminQuery(["admin", "queue"], async () => {
    const pluginsRes = await api.plugins();
    const out: DownloadRow[] = [];
    for (const p of pluginsRes.plugins) {
      // Ask each download-client plugin for its queue; non-clients fail the
      // probe quietly via capability-not-provided errors.
      try {
        const res = await api.invokeCapability(p.manifest.id, QUEUE_CAPABILITY, "list");
        const downloads = ((res.result as { downloads?: DownloadRow[] }).downloads ?? []) as DownloadRow[];
        out.push(...downloads);
      } catch {
        /* not a download client */
      }
    }
    return out;
  });

  const pauseResume = async (row: DownloadRow, op: "pause" | "resume") => {
    // The fixture/qbittorrent/sabnzbd clients expose per-id operations.
    void qc.invalidateQueries({ queryKey: ["admin", "queue"] });
    await api.invokeCapability("dev.tantalar.plugin.fixture-download-client", QUEUE_CAPABILITY, op, {
      downloadId: row.downloadId,
    }).catch(() => undefined);
    void qc.invalidateQueries({ queryKey: ["admin", "queue"] });
  };

  if (q.isPending) return <LoadState />;
  if (q.isError) return <ErrorState message={(q.error as Error).message} onRetry={() => void q.refetch()} />;

  const columns: ReadonlyArray<ColumnDef<DownloadRow, unknown>> = [
    { id: "downloadId", header: "Download", accessorKey: "downloadId" },
    { id: "itemKey", header: "Item", accessorKey: "itemKey" },
    { id: "state", header: "State", accessorKey: "state" },
    { id: "progressPercent", header: "Progress %", accessorKey: "progressPercent" },
    {
      id: "actions",
      header: "Actions",
      enableSorting: false,
      cell: ({ row }) => (
        <Group gap="xs">
          <Button
            size="compact-xs"
            variant="default"
            data-testid={`pause-${row.original.downloadId}`}
            onClick={() => void pauseResume(row.original, "pause")}
          >
            Pause
          </Button>
          <Button
            size="compact-xs"
            variant="default"
            data-testid={`resume-${row.original.downloadId}`}
            onClick={() => void pauseResume(row.original, "resume")}
          >
            Resume
          </Button>
        </Group>
      ),
    },
  ];

  return (
    <Stack gap="sm">
      <Title order={4}>Queue</Title>
      <DenseGrid
        testId="queue-grid"
        columns={columns}
        data={q.data}
        layout={layout}
        onLayoutChange={setLayout}
        emptyMessage="The download queue is empty."
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

// ---- Plugins view -----------------------------------------------------------

export function PluginsView() {
  const q = useAdminQuery(["admin", "plugins"], () => api.plugins());
  if (q.isPending) return <LoadState />;
  if (q.isError) return <ErrorState message={(q.error as Error).message} onRetry={() => void q.refetch()} />;

  return (
    <Stack gap="sm">
      <Title order={4}>Plugins</Title>
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
              <Group justify="space-between">
                <div>
                  <Text fw={600}>{p.manifest.id}</Text>
                  <Text size="sm" c="var(--tantalar-color-text-dimmed)">
                    v{p.manifest.version} · restarts: {p.restartCount}
                  </Text>
                </div>
                <Text size="sm" c={p.state === "running" ? "var(--tantalar-color-success)" : "var(--tantalar-color-warning)"}>
                  {p.state}
                </Text>
              </Group>
            </Paper>
          ))}
        </Stack>
      )}
    </Stack>
  );
}

// ---- Users view -------------------------------------------------------------

export function UsersView() {
  const qc = useQueryClient();
  const q = useAdminQuery(["admin", "users"], () => api.users());
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"admin" | "viewer">("viewer");
  const [error, setError] = useState<string | null>(null);

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

  return (
    <Stack gap="sm">
      <Title order={4}>Users</Title>
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
      <DenseGrid
        testId="users-grid"
        columns={[
          { id: "username", header: "Username", accessorKey: "username" },
          { id: "role", header: "Role", accessorKey: "role" },
          { id: "createdAt", header: "Created", accessorKey: "createdAt" },
        ]}
        data={q.data.users}
        layout={{ hiddenColumns: [], density: "dense" }}
        onLayoutChange={() => undefined}
        emptyMessage="No users."
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
            label={`--tantalar-${key}`}
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
        <Tabs.Tab value="settings">Settings</Tabs.Tab>
        <Tabs.Tab value="system">System</Tabs.Tab>
      </Tabs.List>
      <Tabs.Panel value="queue" pt="sm"><QueueView adminId={adminId} /></Tabs.Panel>
      <Tabs.Panel value="wanted" pt="sm"><WantedView adminId={adminId} /></Tabs.Panel>
      <Tabs.Panel value="history" pt="sm"><HistoryView adminId={adminId} /></Tabs.Panel>
      <Tabs.Panel value="plugins" pt="sm"><PluginsView /></Tabs.Panel>
      <Tabs.Panel value="users" pt="sm"><UsersView /></Tabs.Panel>
      <Tabs.Panel value="activity" pt="sm"><ActivityView /></Tabs.Panel>
      <Tabs.Panel value="settings" pt="sm"><SettingsView adminId={adminId} /><DensityToggle adminId={adminId} /></Tabs.Panel>
      <Tabs.Panel value="system" pt="sm"><SystemHealthView /></Tabs.Panel>
    </Tabs>
  );
}
