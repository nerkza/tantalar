import { DenseGrid, initialExplorerQuery, type ExplorerQuery } from "../admin/DenseGrid";
import { type FormEvent, useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  Alert,
  Box,
  Button,
  Drawer,
  Group,
  NativeSelect,
  NumberInput,
  Paper,
  PasswordInput,
  SimpleGrid,
  Stack,
  Switch,
  Tabs,
  Text,
  TextInput,
  Textarea,
  Title,
} from "@mantine/core";
import { api, type IndexerRecord, type ManagedMediaItem, type ManagedMediaPolicy, type ManagedMediaUpdate, type MediaSearchCandidate, type PlaybackPolicy, type UsenetServerConfig, type UsenetServerWrite, type WantedLedgerItem } from "../api";
import { QueueView, WantedView } from "../admin/views";
import { MediaArtwork, MovieDetails, movieSummary, mediaLabelColumns, mediaLabelFilters } from "../components/MovieMetadata";
import { ErrorBoundary } from "./ErrorBoundary";
import { TitleTags } from "./ReleaseSearchPage";
import { LocalCatalogFiles } from "./LocalCatalogFiles";
import { ActionNotice, useActionFeedback } from "../components/ActionNotice";
import "./operations.css";

function LoadState({ label }: { readonly label: string }) {
  return <Text role="status" aria-busy="true">{label}</Text>;
}

function ErrorState({ message, retry }: { readonly message: string; readonly retry: () => void }) {
  return (
    <Alert color="red" title="Could not load this section" role="alert">
      <Group justify="space-between" align="center">
        <Text size="sm">{message}</Text>
        <Button variant="default" onClick={retry}>Retry</Button>
      </Group>
    </Alert>
  );
}

function formatReleaseSize(bytes: number): string {
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

type IndexerNotice = { readonly tone: "success" | "error"; readonly message: string };

interface IndexerForm {
  readonly name: string;
  readonly protocol: IndexerRecord["protocol"];
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly priority: number;
  readonly enabled: boolean;
  readonly interactiveSearch: boolean;
  readonly automaticSearch: boolean;
  readonly categories: string;
  readonly tags: string;
  readonly maxSearchesPerWindow: number;
  readonly windowSeconds: number;
  readonly retentionDays: number;
}

const NEW_INDEXER: IndexerForm = {
  name: "",
  protocol: "newznab",
  baseUrl: "",
  apiKey: "",
  priority: 25,
  enabled: true,
  interactiveSearch: true,
  automaticSearch: true,
  categories: "",
  tags: "",
  maxSearchesPerWindow: 0,
  windowSeconds: 60,
  retentionDays: 0,
};

function IndexersPanel() {
  const query = useQuery({ queryKey: ["admin", "indexers"], queryFn: api.indexers, retry: false });
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<IndexerRecord | null>(null);
  const [form, setForm] = useState<IndexerForm>(NEW_INDEXER);
  const [busy, setBusy] = useState(false);
  const [workingIndexer, setWorkingIndexer] = useState<string | null>(null);
  const [notice, setNotice] = useState<IndexerNotice | null>(null);
  const [testResult, setTestResult] = useState<Awaited<ReturnType<typeof api.testIndexer>> | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const resetEditor = () => {
    setShowForm(false);
    setEditing(null);
    setTestResult(null);
    setConfirmDelete(false);
  };

  const closeEditor = () => {
    if (!busy) resetEditor();
  };

  const openNew = () => {
    setEditing(null);
    setForm(NEW_INDEXER);
    setTestResult(null);
    setConfirmDelete(false);
    setShowForm(true);
  };

  const openEdit = (indexer: IndexerRecord) => {
    setEditing(indexer);
    setForm({
      name: indexer.name,
      protocol: indexer.protocol,
      baseUrl: indexer.baseUrl,
      apiKey: "",
      priority: indexer.priority,
      enabled: indexer.enabled,
      interactiveSearch: indexer.searchModes?.interactive ?? true,
      automaticSearch: indexer.searchModes?.automatic ?? true,
      categories: (indexer.categories ?? []).join(", "),
      tags: (indexer.tags ?? []).join(", "),
      maxSearchesPerWindow: indexer.limits.maxSearchesPerWindow,
      windowSeconds: Math.round(indexer.limits.windowMs / 1_000),
      retentionDays: indexer.limits.retentionDays,
    });
    setTestResult(null);
    setConfirmDelete(false);
    setShowForm(true);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    try {
      const input = {
        name: form.name.trim(),
        protocol: form.protocol,
        baseUrl: form.baseUrl.trim(),
        ...(editing || form.apiKey ? { apiKey: form.apiKey } : {}),
        priority: form.priority,
        enabled: form.enabled,
        searchModes: { interactive: form.interactiveSearch, automatic: form.automaticSearch },
        categories: form.categories.split(",").map(Number).filter((value) => Number.isInteger(value) && value > 0),
        tags: form.tags.split(",").map((value) => value.trim()).filter(Boolean),
        limits: {
          maxSearchesPerWindow: form.maxSearchesPerWindow,
          windowMs: form.windowSeconds * 1_000,
          retentionDays: form.protocol === "newznab" ? form.retentionDays : 0,
        },
      };
      if (editing) await api.updateIndexer(editing.id, input);
      else await api.createIndexer(input);
      const action = editing ? "updated" : "added";
      resetEditor();
      setNotice({ tone: "success", message: `Indexer ${action}. Test it before relying on searches.` });
      await query.refetch();
    } catch (error) {
      setNotice({ tone: "error", message: `Could not save indexer: ${(error as Error).message}` });
    } finally {
      setBusy(false);
    }
  };

  const runTest = (indexer: IndexerRecord, showDetails = false) => {
    setNotice(null);
    if (showDetails) setTestResult(null);
    setWorkingIndexer(`test:${indexer.id}`);
    void api.testIndexer(indexer.id)
      .then((result) => {
        if (showDetails) setTestResult(result);
        setNotice({
          tone: result.ok ? "success" : "error",
          message: result.ok
            ? `${indexer.name} is reachable.`
            : `${indexer.name} could not be reached: ${result.detail ?? result.code ?? "Connection test failed."}`,
        });
      })
      .catch((error: Error) => setNotice({ tone: "error", message: `Could not test ${indexer.name}: ${error.message}` }))
      .finally(() => setWorkingIndexer(null));
  };

  const remove = async () => {
    if (!editing) return;
    setBusy(true);
    setNotice(null);
    try {
      await api.deleteIndexer(editing.id);
      const name = editing.name;
      resetEditor();
      setNotice({ tone: "success", message: `${name} was removed.` });
      await query.refetch();
    } catch (error) {
      setNotice({ tone: "error", message: `Could not remove ${editing.name}: ${(error as Error).message}` });
    } finally {
      setBusy(false);
    }
  };

  if (query.isPending) return <LoadState label="Loading indexers…" />;
  if (query.isError) return <ErrorState message={(query.error as Error).message} retry={() => void query.refetch()} />;

  const indexers = query.data.indexers ?? [];
  return (
    <Stack gap="md" data-testid="indexers-setup">
      <Group justify="space-between" align="flex-start">
        <div>
          <Text size="sm" c="dimmed">{indexers.length} {indexers.length === 1 ? "indexer" : "indexers"}</Text>
        </div>
        <Button onClick={openNew}>Add indexer</Button>
      </Group>

      <Drawer
        opened={showForm}
        onClose={closeEditor}
        position="right"
        size="md"
        title={editing ? `Edit ${editing.name}` : "Add indexer"}
      >
        <form aria-label={editing ? "Edit indexer" : "Add indexer"} onSubmit={(event) => void submit(event)}>
          <Stack gap="sm">
            <TextInput label="Name" value={form.name} onChange={(event) => setForm({ ...form, name: event.currentTarget.value })} required />
            <NativeSelect
              label="Protocol"
              value={form.protocol}
              onChange={(event) => setForm({ ...form, protocol: event.currentTarget.value as IndexerRecord["protocol"] })}
              data={[
                { value: "newznab", label: "Newznab (Usenet)" },
                { value: "torznab", label: "Torznab (torrent)" },
              ]}
            />
            <TextInput label="Base URL" type="url" value={form.baseUrl} onChange={(event) => setForm({ ...form, baseUrl: event.currentTarget.value })} required />
            <PasswordInput
              label="API key"
              description={editing && editing.hasApiKey ? "Leave blank to keep the saved key." : "Stored securely and never shown again."}
              placeholder={editing?.hasApiKey ? "Saved key" : undefined}
              value={form.apiKey}
              onChange={(event) => setForm({ ...form, apiKey: event.currentTarget.value })}
            />
            <NumberInput label="Priority" min={0} allowDecimal={false} value={form.priority} onChange={(value) => setForm({ ...form, priority: Number(value) || 0 })} />
            <Switch label="Enabled" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.currentTarget.checked })} />
            <Switch label="Interactive search" checked={form.interactiveSearch} onChange={(event) => setForm({ ...form, interactiveSearch: event.currentTarget.checked })} />
            <Switch label="Automatic search" checked={form.automaticSearch} onChange={(event) => setForm({ ...form, automaticSearch: event.currentTarget.checked })} />

            <Box component="details" className="tantalar-indexer-advanced">
              <Text component="summary" fw={600}>Advanced</Text>
              <Stack gap="sm" mt="sm">
                <TextInput
                  label="Categories"
                  description="Comma-separated Newznab category IDs. Empty uses the media category."
                  value={form.categories}
                  onChange={(event) => setForm({ ...form, categories: event.currentTarget.value })}
                />
                <TextInput
                  label="Tags"
                  description="Comma-separated search groups."
                  value={form.tags}
                  onChange={(event) => setForm({ ...form, tags: event.currentTarget.value })}
                />
                <NumberInput
                  label="Automatic searches per window"
                  description="0 means unlimited."
                  min={0}
                  allowDecimal={false}
                  value={form.maxSearchesPerWindow}
                  onChange={(value) => setForm({ ...form, maxSearchesPerWindow: Number(value) || 0 })}
                />
                <NumberInput
                  label="Window (seconds)"
                  min={0}
                  allowDecimal={false}
                  value={form.windowSeconds}
                  onChange={(value) => setForm({ ...form, windowSeconds: Number(value) || 0 })}
                />
                {form.protocol === "newznab" ? (
                  <NumberInput
                    label="Retention (days)"
                    description="Ignore older releases during automatic searches. 0 disables the limit."
                    min={0}
                    allowDecimal={false}
                    value={form.retentionDays}
                    onChange={(value) => setForm({ ...form, retentionDays: Number(value) || 0 })}
                  />
                ) : null}
              </Stack>
            </Box>

            {testResult ? (
              testResult.ok ? <Text size="xs" c="dimmed">Search types: {testResult.searchModes?.join(", ") || "not reported"} · Categories: {testResult.categoryCount ?? 0}</Text> : null
            ) : null}

            {confirmDelete && editing ? (
              <Alert color="red" title={`Remove ${editing.name}?`}>
                <Text size="sm">This removes the saved indexer and API key. It does not delete downloaded media.</Text>
                <Group mt="sm">
                  <Button color="red" loading={busy} onClick={() => void remove()}>Confirm remove</Button>
                  <Button variant="default" disabled={busy} onClick={() => setConfirmDelete(false)}>Keep indexer</Button>
                </Group>
              </Alert>
            ) : null}

            <Group justify="space-between" align="center">
              {editing && !confirmDelete ? (
                <Button color="red" variant="subtle" disabled={busy} onClick={() => setConfirmDelete(true)}>Remove</Button>
              ) : <span />}
              <Group gap="xs">
                {editing ? (
                  <Button
                    variant="default"
                    loading={workingIndexer === `test:${editing.id}`}
                    disabled={busy || workingIndexer !== null}
                    onClick={() => runTest(editing, true)}
                  >
                    Test saved settings
                  </Button>
                ) : null}
                <Button variant="default" disabled={busy} onClick={closeEditor}>Cancel</Button>
                <Button type="submit" loading={busy}>Save indexer</Button>
              </Group>
            </Group>
          </Stack>
        </form>
      </Drawer>

      <ActionNotice message={notice?.message} title="Indexers" severity={notice?.tone} />

      <DenseGrid testId="indexers-grid" ariaLabel="indexers" data={indexers} defaultView="list" rowTestId={item => `indexer-${item.id}`}
        emptyMessage="No indexers configured."
        filters={[{ id: "protocol", label: "Protocols", options: [{ value: "newznab", label: "Usenet" }, { value: "torznab", label: "Torrent" }] }]}
        columns={[
          { id: "name", header: "Name", accessorKey: "name", size: 240 },
          { id: "protocol", header: "Protocol", accessorKey: "protocol", size: 120 },
          { id: "baseUrl", header: "Address", accessorKey: "baseUrl", size: 300 },
          { id: "priority", header: "Priority", accessorKey: "priority", size: 85, meta: { dataType: "number" } },
          { id: "actions", header: "Actions", enableHiding: false, size: 280, cell: ({ row }) => { const indexer = row.original; return (                <Group gap="sm">
                  <Button
                    variant="default"
                    size="compact-sm"
                    loading={workingIndexer === `test:${indexer.id}`}
                    disabled={workingIndexer !== null}
                    onClick={() => runTest(indexer)}
                  >
                    Test
                  </Button>
                  <Button variant="default" size="compact-sm" disabled={workingIndexer !== null} onClick={() => openEdit(indexer)}>
                    Edit
                  </Button>
                  <Switch
                    label="Enabled"
                    checked={indexer.enabled}
                    disabled={workingIndexer !== null}
                    onChange={(event) => {
                      const enabled = event.currentTarget.checked;
                      setNotice(null);
                      setWorkingIndexer(`enabled:${indexer.id}`);
                      void api.setIndexerEnabled(indexer.id, event.currentTarget.checked)
                        .then(async () => {
                          await query.refetch();
                          setNotice({ tone: "success", message: `${indexer.name} is now ${enabled ? "enabled" : "disabled"}.` });
                        })
                        .catch((error: Error) => setNotice({ tone: "error", message: `Could not update ${indexer.name}: ${error.message}` }))
                        .finally(() => setWorkingIndexer(null));
                    }}
                  />
                </Group>); } },
        ]}
      />
    </Stack>
  );
}

const MODULES = {
  usenet: {
    id: "dev.tantalar.plugin.usenet-native",
    name: "Built-in Usenet downloader",
    description: "Native NZB parsing, TLS news-server transport and durable queue state inside Tantalar.",
    limitation: "Implicit TLS is available. Repair requires par2cmdline; archive extraction requires 7-Zip. STARTTLS is not supported.",
  },
  torrent: {
    id: "dev.tantalar.plugin.torrent-native",
    name: "Built-in torrent downloader",
    description: "Embedded peer transfer, queue state and piece verification inside Tantalar.",
    limitation: "Public discovery and DHT remain disabled until VPN confinement passes its real-host safety gate.",
  },
  vpn: {
    id: "dev.tantalar.plugin.vpn-manager",
    name: "VPN manager",
    description: "Prototype VPN profile policy and downloader binding records.",
    limitation: "A running plugin process does not create a tunnel or enforce a network kill switch in this build.",
  },
} as const;

function UsenetSettingsPanel() {
  const query = useQuery({ queryKey: ["admin", "usenet-configuration"], queryFn: api.usenetConfiguration, retry: false });
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("Primary");
  const [host, setHost] = useState("");
  const [port, setPort] = useState(563);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [useEnv, setUseEnv] = useState(false);
  const [passwordEnv, setPasswordEnv] = useState("");
  const [removePassword, setRemovePassword] = useState(false);
  const [connections, setConnections] = useState(4);
  const [priority, setPriority] = useState(0);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [message, setMessage, messageSeverity, messageRevision] = useActionFeedback();
  const [busy, setBusy] = useState(false);

  if (query.isPending) return <LoadState label="Loading Usenet configuration…" />;
  if (query.isError) return <ErrorState message={(query.error as Error).message} retry={() => void query.refetch()} />;
  const current = query.data.servers;
  const withoutSecret = (item: UsenetServerConfig): UsenetServerWrite => ({
    id: item.id,
    name: item.name,
    host: item.host,
    port: item.port,
    tls: item.tls,
    username: item.username,
    priority: item.priority,
    connections: item.connections,
  });
  const openEditor = (item?: UsenetServerConfig) => {
    setEditingId(item?.id ?? null);
    setName(item?.name ?? "Primary");
    setHost(item?.host ?? "");
    setPort(item?.port ?? 563);
    setUsername(item?.username ?? "");
    setConnections(item?.connections ?? 4);
    setPriority(item?.priority ?? current.length);
    setPassword("");
    setConfirmPassword("");
    setUseEnv(item?.passwordSource === "environment");
    setPasswordEnv("");
    setRemovePassword(false);
    setMessage(null);
    setShowForm(true);
  };
  const server = (): UsenetServerWrite => {
    const baseId = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "server";
    const id = editingId ?? (current.some((item) => item.id === baseId) ? `${baseId}-${current.length + 1}` : baseId);
    return {
      id,
      name: name.trim(),
      host: host.trim(),
      port,
      tls: "implicit",
      username: username.trim(),
      priority,
      connections,
      ...(useEnv && passwordEnv.trim() ? { passwordEnv: passwordEnv.trim() } : {}),
      ...(!useEnv && password ? { password, confirmPassword } : {}),
      ...(removePassword ? { removePassword: true } : {}),
    };
  };
  const run = (action: "test" | "save") => {
    setBusy(true);
    setMessage(null);
    const next = server();
    const saved = current.map(withoutSecret);
    const servers = editingId
      ? saved.map((item) => item.id === editingId ? next : item)
      : [...saved, next];
    const task = action === "test" ? api.testUsenetServer(next) : api.configureUsenet(servers);
    void task
      .then(() => {
        setMessage(action === "test" ? "Server connection succeeded." : "Usenet server saved.");
        if (action === "save") {
          setShowForm(false);
          setEditingId(null);
          void query.refetch();
        }
      })
      .catch((error: Error) => setMessage(error.message, "error"))
      .finally(() => setBusy(false));
  };
  const remove = (id: string) => {
    setBusy(true);
    setMessage(null);
    void api.configureUsenet(current.filter((item) => item.id !== id).map(withoutSecret))
      .then(() => {
        setMessage("Usenet server removed.");
        setConfirmRemove(null);
        void query.refetch();
      })
      .catch((error: Error) => setMessage(error.message, "error"))
      .finally(() => setBusy(false));
  };

  return (
    <Paper withBorder p="md" radius="md">
      <Group justify="space-between" align="center">
        <div>
          <Text fw={600}>News servers</Text>
          <Text size="sm" c="dimmed">{current.length === 0 ? "No server configured." : `${current.length} configured.`}</Text>
        </div>
        <Group gap="sm">
          <Text component="span" className="tantalar-inline-state" data-tone={query.data.ready ? "success" : "warning"}>
            {query.data.ready ? "Configured" : "Needs setup"}
          </Text>
          <Button variant="default" onClick={() => showForm ? setShowForm(false) : openEditor()}>{showForm ? "Cancel" : "Add server"}</Button>
        </Group>
      </Group>
      <Text size="sm" c="dimmed" mt="sm">
        Repair: {query.data.limitations?.par2 ? "available" : "par2cmdline missing"} · Archive extraction: {query.data.limitations?.archives ? "available" : "7-Zip missing"}
      </Text>
      {!query.data.ready ? (
        <Text role="alert" size="sm" c="dimmed" mt="sm">
          {query.data.downloadRoots.length === 0
            ? "No download root is configured. Add a download root to the Usenet host configuration, then restart Tantalar."
            : "Add a news server with valid credentials to make the downloader ready."}
        </Text>
      ) : null}
      {current.length > 0 ? (
        <Stack gap="xs" mt="md">
          {current.map((item) => (
            <Group key={item.id} justify="space-between">
              <div><Text>{item.name}</Text><Text size="xs" c="dimmed">{item.host}:{item.port} · {item.connections} connections</Text></div>
              <Group gap="xs">
                <Text component="span" size="sm">{item.hasPassword ? "Password available" : "Password missing"}</Text>
                <Button size="compact-xs" variant="default" disabled={busy} onClick={() => openEditor(item)}>Edit</Button>
                <Button size="compact-xs" variant="subtle" color="red" disabled={busy} onClick={() => setConfirmRemove(item.id)}>Remove</Button>
              </Group>
            </Group>
          ))}
        </Stack>
      ) : null}
      {confirmRemove ? (
        <Alert color="red" title="Remove server?" mt="md">
          <Group mt="sm">
            <Button color="red" loading={busy} onClick={() => remove(confirmRemove)}>Confirm remove</Button>
            <Button variant="default" onClick={() => setConfirmRemove(null)}>Cancel</Button>
          </Group>
        </Alert>
      ) : null}
      {showForm ? (
        <Stack gap="sm" mt="md">
          <TextInput id="usenet-server-name" label="Name" value={name} onChange={(event) => setName(event.currentTarget.value)} required />
          <TextInput id="usenet-server-host" label="Host" value={host} onChange={(event) => setHost(event.currentTarget.value)} required />
          <NumberInput id="usenet-server-port" label="TLS port" min={1} max={65535} value={port} onChange={(value) => setPort(Number(value) || 563)} />
          <TextInput id="usenet-server-username" label="Username" value={username} onChange={(event) => setUsername(event.currentTarget.value)} required />
          {!useEnv ? (
            <>
              <PasswordInput id="usenet-server-password" label="Password" placeholder={editingId ? "Leave blank to keep saved password" : undefined} value={password} onChange={(event) => setPassword(event.currentTarget.value)} required={!editingId} />
              <PasswordInput id="usenet-server-password-confirm" label="Confirm password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.currentTarget.value)} required={Boolean(password)} error={password && confirmPassword && password !== confirmPassword ? "Passwords do not match." : undefined} />
            </>
          ) : null}
          <NumberInput id="usenet-server-connections" label="Connections" min={1} max={32} value={connections} onChange={(value) => setConnections(Number(value) || 1)} />
          <Text size="xs" c="dimmed">Implicit TLS · STARTTLS unavailable</Text>
          <Box component="details">
            <Text component="summary" fw={600}>Advanced</Text>
            <Stack gap="sm" mt="sm">
              <Switch label="Use deployment secret reference" checked={useEnv} onChange={(event) => setUseEnv(event.currentTarget.checked)} />
              {useEnv ? <TextInput id="usenet-server-secret" label="Environment variable" placeholder={editingId ? "Leave blank to keep current reference" : "TANTALAR_SECRET_USENET_PASSWORD1"} value={passwordEnv} onChange={(event) => setPasswordEnv(event.currentTarget.value)} required={!editingId} /> : null}
              <NumberInput label="Priority" min={0} allowDecimal={false} value={priority} onChange={(value) => setPriority(Number(value) || 0)} />
              {editingId ? <Switch label="Remove saved password" checked={removePassword} onChange={(event) => setRemovePassword(event.currentTarget.checked)} /> : null}
            </Stack>
          </Box>
          <Group>
            <Button variant="default" loading={busy} disabled={Boolean(password && password !== confirmPassword)} onClick={() => run("test")}>Test connection</Button>
            <Button loading={busy} disabled={Boolean(password && password !== confirmPassword)} onClick={() => run("save")}>Save server</Button>
          </Group>
        </Stack>
      ) : null}
      <ActionNotice message={message} title="Usenet server" severity={messageSeverity} revision={messageRevision} />
    </Paper>
  );
}

function VpnStatusPanel() {
  const query = useQuery({ queryKey: ["admin", "vpn-status"], queryFn: api.vpnStatus, retry: false });
  const [busy, setBusy] = useState(false);
  const [message, setMessage, messageSeverity, messageRevision] = useActionFeedback();
  if (query.isPending) return <LoadState label="Checking VPN enforcement…" />;
  if (query.isError) return <ErrorState message={(query.error as Error).message} retry={() => void query.refetch()} />;
  const status = query.data;
  return (
    <Paper withBorder p="md" radius="md">
      <Group justify="space-between" align="flex-start">
        <div><Text fw={600}>Host enforcement</Text><Text size="sm" c="dimmed">{status.enforcementReady ? "WireGuard enforcement is available." : "Apply remains disabled until the host safety checks pass."}</Text></div>
        <Text component="span" className="tantalar-inline-state" data-tone={status.enforcementReady ? "success" : "warning"}>{status.enforcementReady ? "Available" : "Blocked"}</Text>
      </Group>
      {status.host.missing.length > 0 ? <Text size="sm" mt="sm">Missing: {status.host.missing.join(", ")}</Text> : null}
      <ActionNotice message={message} title="Usenet settings" severity="error" revision={messageRevision} />
      <Button mt="md" variant="default" loading={busy} onClick={() => {
        setBusy(true);
        setMessage(null);
        void api.vpnPreflight()
          .then(() => query.refetch())
          .catch((error: Error) => setMessage(error.message, "error"))
          .finally(() => setBusy(false));
      }}>Run preflight again</Button>
    </Paper>
  );
}

function TorrentStatusPanel() {
  const query = useQuery({ queryKey: ["admin", "torrent-status"], queryFn: api.torrentStatus, retry: false });
  const [showRoot, setShowRoot] = useState(false);
  const [root, setRoot] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage, messageSeverity, messageRevision] = useActionFeedback();
  if (query.isPending) return <LoadState label="Checking Torrent engine…" />;
  if (query.isError) return <ErrorState message={(query.error as Error).message} retry={() => void query.refetch()} />;
  const status = query.data;
  return (
    <Paper withBorder p="md" radius="md">
      <Group justify="space-between" align="flex-start">
        <div><Text fw={600}>Embedded engine</Text><Text size="sm" c="dimmed">{status.engine} · {status.activeJobs} active jobs</Text></div>
        <Text component="span" className="tantalar-inline-state" data-tone={status.ready ? "success" : "warning"}>{status.ready ? "Ready" : "Needs setup"}</Text>
      </Group>
      <Text size="sm" mt="sm">Download roots: {status.downloadRootsConfigured ? "configured" : "not configured"}</Text>
      <Text size="sm" c="dimmed">DHT and public discovery are off for this safety-bounded alpha.</Text>
      <Button mt="md" variant="default" onClick={() => setShowRoot((value) => !value)}>{showRoot ? "Cancel" : "Set download root"}</Button>
      {showRoot ? (
        <Group mt="sm" align="flex-end">
          <TextInput id="torrent-download-root" label="Absolute download root" value={root} onChange={(event) => setRoot(event.currentTarget.value)} required style={{ flex: 1 }} />
          <Button loading={busy} disabled={!root.trim()} onClick={() => {
            setBusy(true);
            setMessage(null);
            void api.configureTorrent([root.trim()])
              .then(() => {
                setMessage("Torrent download root saved.");
                setShowRoot(false);
                void query.refetch();
              })
              .catch((error: Error) => setMessage(error.message, "error"))
              .finally(() => setBusy(false));
          }}>Save root</Button>
        </Group>
      ) : null}
      <ActionNotice message={message} title="Torrent settings" severity={messageSeverity} revision={messageRevision} />
    </Paper>
  );
}

function ModuleSetupPanel({ module }: { readonly module: keyof typeof MODULES }) {
  const definition = MODULES[module];
  const [showAdd, setShowAdd] = useState(false);
  const [title, setTitle] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [message, setMessage, messageSeverity, messageRevision] = useActionFeedback();
  const [busy, setBusy] = useState(false);
  const query = useQuery({ queryKey: ["admin", "plugins"], queryFn: api.plugins, retry: false });
  if (query.isPending) return <LoadState label={`Checking ${definition.name}…`} />;
  if (query.isError) return <ErrorState message={(query.error as Error).message} retry={() => void query.refetch()} />;

  const plugin = query.data.plugins.find((candidate) => candidate.manifest.id === definition.id);
  const processRunning = plugin?.state === "healthy" || plugin?.state === "running";
  return (
    <Stack gap="md" data-testid={`${module}-setup`}>
      <Paper
        withBorder
        p="md"
        radius="md"
        className="tantalar-module-summary"
        data-state={processRunning ? "running" : plugin ? "stopped" : "unmounted"}
      >
        <Group justify="space-between" align="flex-start" wrap="wrap">
          <div className="tantalar-module-summary__copy">
            <Title order={3}>{definition.name}</Title>
            <Text size="sm" c="dimmed" mt={4}>{definition.description}</Text>
          </div>
          <Text component="span" className="tantalar-inline-state" data-tone={processRunning ? "success" : plugin ? "warning" : "neutral"}>
            {processRunning ? "Process running" : plugin ? `Process ${plugin.state}` : "Not mounted"}
          </Text>
        </Group>
        <div className="tantalar-module-summary__details">
          <Text size="sm" fw={600}>{module === "vpn" ? "Enforcement not ready" : "Current limitation"}</Text>
          <Text size="sm" c="dimmed">{definition.limitation}</Text>
          <Text size="sm" c="dimmed">
            {!plugin
              ? "Enable this module in the host configuration, then restart Tantalar."
              : !processRunning
                ? "Review the extension failure in Audit, then restart Tantalar."
                : module === "usenet"
                  ? "Server settings use environment secret references; passwords never return to the browser."
                  : module === "vpn"
                    ? "Status and host preflight are available; tunnel Apply stays disabled."
                    : "Manual jobs use Tantalar's embedded engine and shared durable queue."}
          </Text>
        </div>
      </Paper>
      {module === "usenet" && processRunning ? <UsenetSettingsPanel /> : null}
      {module === "torrent" && processRunning ? <TorrentStatusPanel /> : null}
      {module === "vpn" && processRunning ? <VpnStatusPanel /> : null}
      {module !== "vpn" && processRunning ? (
        <Stack gap="sm" align="flex-start">
          <Button variant="default" onClick={() => setShowAdd((value) => !value)}>
            {showAdd ? "Cancel" : `Add ${module === "usenet" ? "Usenet" : "Torrent"} job`}
          </Button>
          {showAdd ? (
            <Paper
              component="form"
              withBorder
              p="md"
              w="100%"
              onSubmit={(event: FormEvent) => {
                event.preventDefault();
                setBusy(true);
                setMessage(null);
                void api.createDownload({ kind: module, title: title.trim(), sourceUrl: sourceUrl.trim() })
                  .then((result) => {
                    setMessage(result.created ? "Job added to Downloads." : "That job is already in Downloads.");
                    setTitle("");
                    setSourceUrl("");
                  })
                  .catch((error: Error) => setMessage(error.message, "error"))
                  .finally(() => setBusy(false));
              }}
            >
              <Stack gap="sm">
                <TextInput id={`native-${module}-title`} label="Title" value={title} onChange={(event) => setTitle(event.currentTarget.value)} required />
                <TextInput
                  id={`native-${module}-source`}
                  label={module === "usenet" ? "NZB URL or server path" : "Magnet link, torrent URL or server path"}
                  value={sourceUrl}
                  onChange={(event) => setSourceUrl(event.currentTarget.value)}
                  required
                />
                <Button type="submit" loading={busy}>Add to Downloads</Button>
              </Stack>
            </Paper>
          ) : null}
          <ActionNotice message={message} title="Downloads" severity={messageSeverity} revision={messageRevision} />
        </Stack>
      ) : null}
    </Stack>
  );
}

interface ManagedEditForm {
  title: string;
  year: string;
  overview: string;
  artworkUrl: string;
  destinationLibraryId: string;
  qualityProfile: ManagedMediaPolicy["qualityProfile"];
  languages: string;
  minimumAvailability: ManagedMediaPolicy["minimumAvailability"];
  monitorMode: ManagedMediaPolicy["monitorMode"];
  monitored: boolean;
}

export type ManagedReleaseTarget = Pick<WantedLedgerItem, "kind" | "id" | "episodeKey">;

function MediaManagementPanel({
  mode,
  releaseTarget,
  onReleaseTargetOpened,
  onOpenManagedReleases,
}: {
  readonly mode: "discover" | "managed";
  readonly releaseTarget?: ManagedReleaseTarget | null;
  readonly onReleaseTargetOpened?: () => void;
  readonly onOpenManagedReleases?: (item: ManagedMediaItem) => void;
}) {
  const [input, setInput] = useState("");
  const [kind, setKind] = useState<"movie" | "series" | "all">("all");
  const [managedQuery, setManagedQuery] = useState<ExplorerQuery>(initialExplorerQuery);
  const [search, setSearch] = useState<{ query: string; kind: "movie" | "series" | "all" } | null>(null);
  useEffect(() => {
    if (mode !== "discover") return;
    const timer = window.setTimeout(() => setSearch(input.trim().length >= 2 ? { query: input.trim(), kind } : null), 350);
    return () => window.clearTimeout(timer);
  }, [input, kind, mode]);
  const [saving, setSaving] = useState<string | null>(null);
  const [notice, setNotice, noticeSeverity, noticeRevision] = useActionFeedback();
  const [selected, setSelected] = useState<MediaSearchCandidate | null>(null);
  const [editing, setEditing] = useState<ManagedMediaItem | null>(null);
  const [editForm, setEditForm] = useState<ManagedEditForm | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [matchFileId, setMatchFileId] = useState("");
  const [matchEpisodeKey, setMatchEpisodeKey] = useState("");
  const [metadataReview, setMetadataReview] = useState<import("../api").MetadataReview | null>(null);
  const [episodeQuery, setEpisodeQuery] = useState<ExplorerQuery>(initialExplorerQuery);
  const [policy, setPolicy] = useState<ManagedMediaPolicy>({
    qualityProfile: "hd",
    minimumAvailability: "released",
    monitorMode: "all",
    monitored: true,
    languages: "",
  });
  const results = useQuery({
    queryKey: ["media", "discover", search?.query, search?.kind],
    queryFn: ({ signal }) => api.searchMedia(search!.query, search!.kind, signal),
    enabled: search !== null,
    retry: false,
  });
  const managed = useQuery<Awaited<ReturnType<typeof api.managedMediaPage>>>({
    queryKey: ["admin", "media", "managed", mode, mode === "managed" ? managedQuery : null],
    placeholderData: keepPreviousData,
    queryFn: async ({ signal }) => mode === "managed" ? api.managedMediaPage(managedQuery, signal) : api.managedMedia(signal).then(result => ({ ...result, total: result.items.length, facets: {} as Record<string, string[]>, tags: [...new Set(result.items.flatMap(item => item.tags ?? []))] })),
    retry: false,
  });
  const libraries = useQuery({ queryKey: ["admin", "libraries"], queryFn: api.libraries, retry: false });
  const managedDetail = useQuery({
    queryKey: ["admin", "media", "managed", editing?.kind, editing?.id, "detail"],
    queryFn: ({ signal }) => api.managedMediaDetail(editing!.kind, editing!.id, signal),
    enabled: editing !== null,
    retry: false,
  });
  const matchFiles = useQuery({
    queryKey: ["admin", "catalog", "match", editForm?.destinationLibraryId],
    queryFn: () => api.catalogPage({ pageSize: 200, libraryId: editForm!.destinationLibraryId }),
    enabled: Boolean(editing && editForm?.destinationLibraryId),
    retry: false,
  });
  const episodePage = useQuery({
    queryKey: ["admin", "media", "episodes", editing?.id, episodeQuery],
    queryFn: ({ signal }) => api.managedEpisodes(editing!.id, episodeQuery, signal),
    enabled: editing?.kind === "series",
    placeholderData: keepPreviousData,
  });

  const compatibleLibraries = (candidate: MediaSearchCandidate) =>
    (libraries.data?.libraries ?? []).filter((library) => library.enabled && (library.kind === "mixed" || library.kind === candidate.kind));

  const openAdd = (candidate: MediaSearchCandidate) => {
    setSelected(candidate);
    setPolicy({
      destinationLibraryId: compatibleLibraries(candidate)[0]?.id,
      qualityProfile: candidate.kind === "movie" ? "uhd" : "hd",
      minimumAvailability: "released",
      monitorMode: "all",
      monitored: true,
      languages: "",
    });
  };

  const openReleases = (item: ManagedMediaItem, episodeKey?: string) => {
    window.location.hash = `/admin/media/releases/${item.kind}/${encodeURIComponent(item.id)}${episodeKey ? `/${episodeKey}` : ""}`;
  };

  useEffect(() => {
    if (mode !== "managed" || !releaseTarget || !managed.data || managed.isFetching) return;
    const item = managed.data.items.find((candidate) =>
      candidate.kind === releaseTarget.kind && candidate.id === releaseTarget.id,
    );
    if (item) openReleases(item, releaseTarget.episodeKey);
    else setNotice("The wanted item is no longer managed.", "error");
    onReleaseTargetOpened?.();
  }, [mode, releaseTarget, managed.data, managed.isFetching, onReleaseTargetOpened]);

  const add = async (searchNow = false) => {
    if (!selected) return;
    const candidate = selected;
    const key = `${candidate.provider}:${candidate.externalId}`;
    setSaving(key);
    setNotice(null);
    try {
      const result = await api.addManagedMedia(candidate, policy);
      setNotice(result.created ? `${candidate.title} added.` : `${candidate.title} is already managed.`);
      await managed.refetch();
      setSelected(null);
      if (searchNow) onOpenManagedReleases?.(result.item);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The title could not be added.", "error");
    } finally {
      setSaving(null);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const query = input.trim();
    if (query.length >= 2) {
      setNotice(null);
      setSearch({ query, kind });
    }
  };


  const openEdit = (item: ManagedMediaItem) => {
    setMetadataReview(null);
    setEpisodeQuery(initialExplorerQuery);
    setEditing(item);
    setEditForm({
      title: item.title,
      year: item.year ? String(item.year) : "",
      overview: item.overview ?? "",
      artworkUrl: "",
      destinationLibraryId: item.destinationLibraryId ?? "",
      qualityProfile: item.qualityProfile === "any" || item.qualityProfile === "uhd" ? item.qualityProfile : "hd",
      languages: (item.preferredLanguages ?? []).join(", "),
      minimumAvailability: item.minimumAvailability === "announced" || item.minimumAvailability === "in-cinemas" ? item.minimumAvailability : "released",
      monitorMode: item.monitorMode === "future" || item.monitorMode === "missing" || item.monitorMode === "none" ? item.monitorMode : "all",
      monitored: item.monitored,
    });
    setMatchFileId("");
    setMatchEpisodeKey("");
  };

  const saveEdit = async () => {
    if (!editing || !editForm) return;
    const update: ManagedMediaUpdate = {
      ...(editForm.destinationLibraryId ? { destinationLibraryId: editForm.destinationLibraryId } : {}),
      qualityProfile: editForm.qualityProfile,
      languages: editForm.languages.split(",").map((value) => value.trim()).filter(Boolean),
      minimumAvailability: editForm.minimumAvailability,
      ...(editing.kind === "series" ? { monitorMode: editForm.monitorMode } : { monitored: editForm.monitored }),
      ...(editForm.title.trim() !== editing.title ? { title: editForm.title.trim() } : {}),
      ...(editForm.year && Number(editForm.year) !== editing.year ? { year: Number(editForm.year) } : {}),
      ...(editForm.overview !== (editing.overview ?? "") ? { overview: editForm.overview } : {}),
      ...(editForm.artworkUrl.trim() ? { artworkUrl: editForm.artworkUrl.trim() } : {}),
    };
    setWorking("save");
    setNotice(null);
    try {
      await api.updateManagedMedia(editing.kind, editing.id, update);
      setNotice(`${editForm.title} updated.`);
      await Promise.all([managed.refetch(), managedDetail.refetch()]);
      setEditing(null);
      setEditForm(null);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The title could not be updated.", "error");
    } finally {
      setWorking(null);
    }
  };

  const refreshMetadata = async (reviewToken?: string) => {
    if (!editing) return;
    setWorking("refresh");
    try {
      await api.refreshManagedMedia(editing.kind, editing.id, reviewToken);
      setMetadataReview(null);
      setNotice(`${editing.title} metadata refreshed. Manual fields were preserved.`);
      await Promise.all([managed.refetch(), managedDetail.refetch()]);
      if (editing.kind === "series") await episodePage.refetch();
    } catch (error) {
      const review = (error as { review?: import("../api").MetadataReview }).review;
      if (review) { setMetadataReview(review); return; }
      setNotice(error instanceof Error ? error.message : "Metadata refresh failed.", "error");
    } finally {
      setWorking(null);
    }
  };

  const unmonitor = async () => {
    if (!editing) return;
    setWorking("unmonitor");
    try {
      await api.updateManagedMedia(editing.kind, editing.id, editing.kind === "series" ? { monitorMode: "none" } : { monitored: false });
      setNotice(`${editing.title} is no longer monitored.`);
      await managed.refetch();
      setEditing(null);
      setEditForm(null);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Monitoring could not be changed.", "error");
    } finally {
      setWorking(null);
    }
  };

  const matchFile = async () => {
    if (!editing || !matchFileId || (editing.kind === "series" && !matchEpisodeKey)) return;
    setWorking("match");
    try {
      await api.matchManagedMedia(editing.kind, editing.id, matchFileId, editing.kind === "series" ? matchEpisodeKey : undefined);
      setNotice("Catalog file matched.");
      setMatchFileId("");
      setMatchEpisodeKey("");
      await Promise.all([managed.refetch(), managedDetail.refetch(), matchFiles.refetch()]);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The file could not be matched.", "error");
    } finally {
      setWorking(null);
    }
  };

  const removeManaged = async () => {
    if (!editing || !window.confirm(`Delete ${editing.title} from managed media? Catalog files will not be deleted.`)) return;
    setWorking("delete");
    try {
      await api.deleteManagedMedia(editing.kind, editing.id);
      setNotice(`${editing.title} removed. Catalog files were kept.`);
      await managed.refetch();
      setEditing(null);
      setEditForm(null);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The title could not be removed.", "error");
    } finally {
      setWorking(null);
    }
  };

  return (
    <Stack gap="xl" className="tantalar-media-search">
      <ActionNotice message={notice} title="Managed media" severity={noticeSeverity} revision={noticeRevision} />
      {mode === "discover" ? <Box component="section">
        <Box component="form" onSubmit={submit} maw={780}>
          <Group align="end" wrap="wrap">
            <TextInput
              label="Title"
              placeholder="Movie or series title"
              autoFocus
              value={input}
              onChange={(event) => setInput(event.currentTarget.value)}
              minLength={2}
              required
              flex="1 1 360px"
            />
            <NativeSelect
              label="Type"
              value={kind}
              onChange={(event) => setKind(event.currentTarget.value as "movie" | "series" | "all")}
              data={[
                { value: "all", label: "Movies and series" },
                { value: "movie", label: "Movies" },
                { value: "series", label: "Series" },
              ]}
            />
            <Button type="submit" loading={results.isFetching}>Search</Button>
          </Group>
        </Box>

        {results.isError ? <ErrorState message={(results.error as Error).message} retry={() => void results.refetch()} /> : null}
        {results.data ? (
          <Stack gap="xs" mt="lg" maw={960}>
            {results.data.candidates.length === 0 ? <Text c="dimmed">No matching titles.</Text> : null}
            {results.data.candidates.map((candidate) => {
              const key = `${candidate.provider}:${candidate.externalId}`;
              return (
                <Paper key={key} withBorder p="md" className="tantalar-media-result">
                  <Group justify="space-between" align="flex-start" wrap="wrap">
                    <Group align="flex-start" wrap="nowrap" className="tantalar-media-result-copy">
                      <MediaArtwork src={candidate.artworkUrl} title={candidate.title} compact />
                      <Box>
                        <Text fw={650}>{candidate.title}{candidate.year ? ` (${candidate.year})` : ""}</Text>
                        <Text size="sm" c="dimmed">{candidate.kind === "movie" ? "Movie" : "Series"} · {candidate.provider}</Text>
                        {candidate.kind === "movie" ? <Text size="sm" c="dimmed">{movieSummary(candidate)} · {managed.data?.items.some((item) => item.provider === candidate.provider && item.externalId === candidate.externalId) ? "Managed" : "Not managed"}</Text> : null}
                        {candidate.overview ? <Text size="sm" mt="xs" lineClamp={3}>{candidate.overview}</Text> : null}
                        <details><summary>{candidate.kind === "movie" ? "Movie details" : "Series details"}</summary><MovieDetails item={candidate} /></details>
                      </Box>
                    </Group>
                    <Button variant="default" loading={saving === key} disabled={libraries.isLoading || libraries.isError} onClick={() => openAdd(candidate)}>Add</Button>
                  </Group>
                </Paper>
              );
            })}
          </Stack>
        ) : null}
      </Box> : null}

      {mode === "managed" ? <LocalCatalogFiles /> : null}
      {mode === "managed" ? <Box component="section">
        {managed.isError ? <ErrorState message={(managed.error as Error).message} retry={() => void managed.refetch()} /> : null}
        <DenseGrid<ManagedMediaItem>
          testId="managed-titles-grid" ariaLabel="managed titles" defaultView="list"
          data={managed.data?.items ?? []} total={managed.data?.total ?? 0}
          loading={managed.isFetching} onQueryChange={setManagedQuery}
          emptyMessage="No matching managed titles."
          artwork={item => <MediaArtwork src={item.artworkUrl} title={item.title} />}
          filters={[
            ...mediaLabelFilters(managed.data?.facets),
            { id: "kind", label: "Types", options: [{ value: "movie", label: "Movies" }, { value: "series", label: "Series" }] },
            { id: "tags", label: "Tags", options: (managed.data?.tags ?? []).map(value => ({ value, label: value })) },
            { id: "acquisitionState", label: "States", options: (managed.data?.facets?.acquisitionState ?? []).map(value => ({ value, label: value })) },
          ]}
          columns={[
            { id: "title", header: "Title", accessorKey: "title", size: 280 },
            { id: "kind", header: "Type", accessorKey: "kind", size: 90 },
            ...mediaLabelColumns<ManagedMediaItem>(),
            { id: "localFileCount", header: "Local files", accessorFn: item => item.localFileCount ?? 0, size: 95, meta: { dataType: "number" } },
            { id: "tags", header: "Tags", accessorFn: item => item.tags?.join(", ") ?? "", size: 140 },
            { id: "acquisitionState", header: "State", accessorFn: item => item.acquisitionState ?? (item.monitored ? "wanted" : "unmonitored"), size: 115 },
            { id: "actions", header: "Actions", enableHiding: false, size: 235, cell: ({ row }) => <Group gap="xs"><Button variant="default" size="xs" onClick={() => openEdit(row.original)}>Edit</Button><Button variant="default" size="xs" onClick={() => openReleases(row.original)}>Search releases</Button></Group> },
          ]}
        />
      </Box> : null}

      <Drawer
        opened={selected !== null}
        onClose={() => setSelected(null)}
        title={selected ? `Add ${selected.title}` : "Add title"}
        position="right"
        size="md"
      >
        {selected ? (
          <Stack component="form" onSubmit={(event) => { event.preventDefault(); void add(); }}>
            <MediaArtwork src={selected.artworkUrl} title={selected.title} compact />
            <MovieDetails item={selected} />
            <Text>{selected.kind === "movie" ? "Movie" : "Series"}{selected.year ? ` · ${selected.year}` : ""}</Text>
            <NativeSelect
              label="Destination library"
              value={policy.destinationLibraryId ?? ""}
              onChange={(event) => setPolicy({ ...policy, destinationLibraryId: event.currentTarget.value || undefined })}
              data={compatibleLibraries(selected).length > 0
                ? compatibleLibraries(selected).map((library) => ({ value: library.id, label: library.name }))
                : [{ value: "", label: "No compatible library" }]}
              required
            />
            <NativeSelect
              label="Quality profile"
              value={policy.qualityProfile}
              onChange={(event) => setPolicy({ ...policy, qualityProfile: event.currentTarget.value as ManagedMediaPolicy["qualityProfile"] })}
              data={[
                { value: "any", label: "Any quality" },
                { value: "hd", label: "HD — prefer 1080p" },
                { value: "uhd", label: "UHD — prefer 2160p" },
              ]}
            />
            <NativeSelect
              label="Minimum availability"
              value={policy.minimumAvailability}
              onChange={(event) => setPolicy({ ...policy, minimumAvailability: event.currentTarget.value as ManagedMediaPolicy["minimumAvailability"] })}
              data={[
                { value: "announced", label: "Announced" },
                { value: "in-cinemas", label: "In cinemas" },
                { value: "released", label: "Released" },
              ]}
            />
            <TextInput
              label="Languages"
              description="Comma-separated provider language names or codes. Empty accepts all."
              value={policy.languages}
              onChange={(event) => setPolicy({ ...policy, languages: event.currentTarget.value })}
            />
            {selected.kind === "series" ? (
              <NativeSelect
                label="Monitor"
                value={policy.monitorMode}
                onChange={(event) => setPolicy({ ...policy, monitorMode: event.currentTarget.value as ManagedMediaPolicy["monitorMode"] })}
                data={[
                  { value: "all", label: "All episodes" },
                  { value: "future", label: "Future episodes" },
                  { value: "missing", label: "Missing episodes" },
                  { value: "none", label: "None" },
                ]}
              />
            ) : (
              <NativeSelect
                label="Monitor"
                value={policy.monitored ? "yes" : "no"}
                onChange={(event) => setPolicy({ ...policy, monitored: event.currentTarget.value === "yes" })}
                data={[{ value: "yes", label: "Monitored" }, { value: "no", label: "Unmonitored" }]}
              />
            )}
            {compatibleLibraries(selected).length === 0 ? (
              <Alert color="red">Create and enable a compatible library before adding this title.</Alert>
            ) : null}
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setSelected(null)}>Cancel</Button>
              <Button type="submit" loading={saving !== null} disabled={!policy.destinationLibraryId}>Add title</Button>
              <Button type="button" loading={saving !== null} disabled={!policy.destinationLibraryId} onClick={() => void add(true)}>Add &amp; search</Button>
            </Group>
          </Stack>
        ) : null}
      </Drawer>

      <Drawer
        opened={editing !== null}
        onClose={() => { setEditing(null); setEditForm(null); }}
        title={editing ? `Manage ${editing.title}` : "Manage title"}
        position="right"
        size="lg"
      >
        {managedDetail.isLoading ? <LoadState label="Loading title" /> : null}
        {managedDetail.isError ? <ErrorState message={(managedDetail.error as Error).message} retry={() => void managedDetail.refetch()} /> : null}
        {editing && editForm ? (
          <Stack component="form" onSubmit={(event) => { event.preventDefault(); void saveEdit(); }}>
            <MediaArtwork src={managedDetail.data?.item.artworkUrl} title={editForm.title} compact />
            {managedDetail.data?.item ? <MovieDetails item={managedDetail.data.item} /> : null}
            {managedDetail.data ? <TitleTags item={managedDetail.data.item} /> : null}
            <TextInput label="Title" value={editForm.title} required onChange={(event) => setEditForm({ ...editForm, title: event.currentTarget.value })} />
            <TextInput label="Year" type="number" min={1800} max={3000} value={editForm.year} onChange={(event) => setEditForm({ ...editForm, year: event.currentTarget.value })} />
            <Textarea label="Overview" minRows={3} autosize value={editForm.overview} onChange={(event) => setEditForm({ ...editForm, overview: event.currentTarget.value })} />
            <TextInput label="Replacement artwork URL" placeholder="https://image.tmdb.org/..." value={editForm.artworkUrl} onChange={(event) => setEditForm({ ...editForm, artworkUrl: event.currentTarget.value })} />
            <NativeSelect
              label="Destination library"
              value={editForm.destinationLibraryId}
              onChange={(event) => setEditForm({ ...editForm, destinationLibraryId: event.currentTarget.value })}
              data={(libraries.data?.libraries ?? [])
                .filter((library) => library.enabled && (library.kind === "mixed" || library.kind === editing.kind))
                .map((library) => ({ value: library.id, label: library.name }))}
            />
            <NativeSelect
              label="Quality profile"
              value={editForm.qualityProfile}
              onChange={(event) => setEditForm({ ...editForm, qualityProfile: event.currentTarget.value as ManagedMediaPolicy["qualityProfile"] })}
              data={[{ value: "any", label: "Any quality" }, { value: "hd", label: "HD — prefer 1080p" }, { value: "uhd", label: "UHD — prefer 2160p" }]}
            />
            <NativeSelect
              label="Minimum availability"
              value={editForm.minimumAvailability}
              onChange={(event) => setEditForm({ ...editForm, minimumAvailability: event.currentTarget.value as ManagedMediaPolicy["minimumAvailability"] })}
              data={[{ value: "announced", label: "Announced" }, { value: "in-cinemas", label: "In cinemas" }, { value: "released", label: "Released" }]}
            />
            <TextInput
              label="Languages"
              description="Known provider language values outside this list are rejected."
              value={editForm.languages}
              onChange={(event) => setEditForm({ ...editForm, languages: event.currentTarget.value })}
            />
            {editing.kind === "series" ? (
              <NativeSelect
                label="Monitor"
                value={editForm.monitorMode}
                onChange={(event) => setEditForm({ ...editForm, monitorMode: event.currentTarget.value as ManagedMediaPolicy["monitorMode"] })}
                data={[{ value: "all", label: "All episodes" }, { value: "future", label: "Future episodes" }, { value: "missing", label: "Missing episodes" }, { value: "none", label: "None" }]}
              />
            ) : (
              <NativeSelect
                label="Monitor"
                value={editForm.monitored ? "yes" : "no"}
                onChange={(event) => setEditForm({ ...editForm, monitored: event.currentTarget.value === "yes" })}
                data={[{ value: "yes", label: "Monitored" }, { value: "no", label: "Unmonitored" }]}
              />
            )}
            {managedDetail.data?.item.manualFields?.length ? (
              <Text size="sm" c="dimmed">Manual fields: {managedDetail.data.item.manualFields.join(", ")}. Metadata refresh keeps these values.</Text>
            ) : null}
            <Group justify="flex-end">
              <Button type="button" variant="default" loading={working === "refresh"} onClick={() => void refreshMetadata()}>Refresh metadata</Button>
              {editing.monitored ? <Button type="button" variant="default" loading={working === "unmonitor"} onClick={() => void unmonitor()}>Unmonitor</Button> : null}
              <Button type="submit" loading={working === "save"}>Save changes</Button>
            </Group>

            {metadataReview ? <Stack gap="sm" role="region" aria-label="Review metadata changes">
              <Title order={4}>Review metadata changes</Title>
              {metadataReview.changes.map(change => <div key={change.label}><Text fw={600}>{change.label}</Text><Text size="sm">Current: {change.before}</Text><Text size="sm">Provider: {change.after}</Text></div>)}
              <Group><Button type="button" variant="default" onClick={() => setMetadataReview(null)}>Keep current metadata</Button><Button type="button" loading={working === "refresh"} onClick={() => void refreshMetadata(metadataReview.token)}>Apply reviewed changes</Button></Group>
            </Stack> : null}

            {editing.kind === "series" ? <details>
              <summary>Episodes</summary>
              {episodePage.isError ? <ErrorState message={episodePage.error.message} retry={() => void episodePage.refetch()} /> : null}
              <DenseGrid<import("../api").EpisodePresentation> testId="series-episodes-grid" ariaLabel="series episodes" data={episodePage.data?.items ?? []} total={episodePage.data?.total ?? 0} onQueryChange={setEpisodeQuery} loading={episodePage.isFetching} defaultView="list"
                emptyMessage="No episodes. Refresh metadata to retrieve them."
                artwork={episode => <MediaArtwork src={episode.artworkUrl} title={episode.title} variant="backdrop" />}
                filters={[{ id: "season", label: "Season", options: (episodePage.data?.facets.season ?? []).map(value => ({ value, label: `Season ${value}` })) }]}
                columns={[
                  { id: "title", header: "Title", accessorKey: "title", size: 240 },
                  { id: "episodeKey", header: "Episode", accessorKey: "episodeKey", size: 100, meta: { compact: true } },
                  { id: "airDate", header: "Air date", accessorKey: "airDate", size: 115 },
                  { id: "runtimeMinutes", header: "Runtime", accessorKey: "runtimeMinutes", size: 90, cell: ({ row }) => row.original.runtimeMinutes ? `${row.original.runtimeMinutes} min` : "Unknown" },
                  { id: "actions", header: "Actions", enableHiding: false, size: 160, cell: ({ row }) => <Button type="button" size="xs" variant="default" onClick={() => openReleases(editing, row.original.episodeKey)}>Search releases</Button> },
                ]}
              />
            </details> : null}

            <Title order={4} mt="md">Match existing file</Title>
            {managedDetail.data?.files.map((file) => (
              <Text key={file.fileId} size="sm">{file.path.split(/[\\/]/).pop()} · {file.quality}</Text>
            ))}
            <NativeSelect
              label="Catalog file"
              value={matchFileId}
              onChange={(event) => setMatchFileId(event.currentTarget.value)}
              data={matchFiles.data?.items.length
                ? [{ value: "", label: "Choose a file" }, ...matchFiles.data.items.map((file) => ({ value: file.fileId, label: `${file.path.split(/[\\/]/).pop()} · ${file.quality}` }))]
                : [{ value: "", label: "No catalog files in this library" }]}
            />
            {editing.kind === "series" ? (
              <NativeSelect
                label="Episode"
                value={matchEpisodeKey}
                onChange={(event) => setMatchEpisodeKey(event.currentTarget.value)}
                data={managedDetail.data?.item.episodes.length
                  ? [{ value: "", label: "Choose an episode" }, ...managedDetail.data.item.episodes.map((episode) => ({ value: episode.episodeKey, label: `${episode.episodeKey} · ${episode.title}` }))]
                  : [{ value: "", label: "No episode metadata" }]}
              />
            ) : null}
            <Group justify="space-between">
              <Button type="button" color="red" variant="outline" loading={working === "delete"} onClick={() => void removeManaged()}>Delete managed item</Button>
              <Button type="button" variant="default" loading={working === "match"} disabled={!matchFileId || (editing.kind === "series" && !matchEpisodeKey)} onClick={() => void matchFile()}>Match file</Button>
            </Group>
          </Stack>
        ) : null}
      </Drawer>

    </Stack>
  );
}

export function DiscoveryView({
  onOpenManagedReleases,
}: {
  readonly onOpenManagedReleases?: (item: ManagedMediaItem) => void;
}) {
  return (
    <Stack gap="lg">
      <MediaManagementPanel mode="discover" onOpenManagedReleases={onOpenManagedReleases} />
    </Stack>
  );
}

export function ManagedTitlesControl({
  releaseTarget,
  onReleaseTargetOpened,
}: {
  readonly releaseTarget?: ManagedReleaseTarget | null;
  readonly onReleaseTargetOpened?: () => void;
}) {
  return (
    <MediaManagementPanel
      mode="managed"
      releaseTarget={releaseTarget}
      onReleaseTargetOpened={onReleaseTargetOpened}
    />
  );
}

export function MetadataControl() {
  const status = useQuery({ queryKey: ["admin", "media", "metadata"], queryFn: api.metadataStatus, retry: false });
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice, noticeSeverity, noticeRevision] = useActionFeedback();

  const configure = async (credential: string) => {
    setSaving(true);
    setNotice(null);
    try {
      const next = await api.configureMetadata(credential);
      setApiKey("");
      status.refetch();
      setNotice(next.mode === "direct" ? "Direct TMDB access enabled." : "Hosted metadata access enabled.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Metadata access could not be changed.", "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Stack gap="lg" maw={720}>
      <Box component="section">
        <Title order={2} mb="sm">Provider status</Title>
        {status.isLoading ? <LoadState label="Loading metadata status" /> : null}
        {status.isError ? <ErrorState message={(status.error as Error).message} retry={() => void status.refetch()} /> : null}
        {status.data ? (
          <Stack gap="xs">
            <Text>Provider: TMDB</Text>
            <Text>Mode: {status.data.mode === "direct" ? "Direct" : status.data.mode === "hosted" ? "Hosted" : "Fixture"}</Text>
            <Text>Status: {status.data.state === "rate-limited" ? "Rate limited" : status.data.state === "ready" ? "Ready" : "Unavailable"}</Text>
            {status.data.locale ? <Text>Locale: {status.data.locale}</Text> : null}
          </Stack>
        ) : null}
      </Box>

      <Alert title="Hosted metadata privacy">
        Hosted searches send the query and request IP address to Tantalar and TMDB. A personal key sends metadata requests directly to TMDB.
      </Alert>

      <Box component="section">
        <details>
          <summary>Direct provider override</summary>
          <Stack component="form" gap="sm" mt="sm" onSubmit={(event) => { event.preventDefault(); void configure(apiKey.trim()); }}>
            <PasswordInput
              label="Personal TMDB API key"
              description="Leave hosted mode enabled unless this installation needs its own TMDB quota. The key is stored by the server and is never returned to the browser."
              value={apiKey}
              onChange={(event) => setApiKey(event.currentTarget.value)}
              autoComplete="off"
            />
            <Group>
              <Button type="submit" loading={saving} disabled={!apiKey.trim()}>Use personal key</Button>
              {status.data?.directKeyConfigured ? (
                <Button type="button" variant="default" loading={saving} onClick={() => void configure("")}>Use hosted access</Button>
              ) : null}
            </Group>
            <ActionNotice message={notice} title="Metadata settings" severity={noticeSeverity} revision={noticeRevision} />
          </Stack>
        </details>
      </Box>

      <Text size="sm" c="dimmed">
        Metadata provided by <a href="https://www.themoviedb.org/" target="_blank" rel="noreferrer">TMDB</a>. Tantalar is not endorsed or certified by TMDB.
      </Text>
    </Stack>
  );
}

export type AcquisitionSection = "indexers" | "usenet" | "torrent" | "vpn" | "downloads";

export function AcquisitionControl({
  adminId,
  activeSection = "indexers",
  onSearchManagedReleases,
  onSectionChange,
}: {
  readonly adminId: string | null;
  readonly activeSection?: AcquisitionSection;
  readonly onSearchManagedReleases?: (target: WantedLedgerItem) => void;
  readonly onSectionChange?: (section: AcquisitionSection) => void;
}) {
  const [active, setActive] = useState<AcquisitionSection>(activeSection);
  useEffect(() => setActive(activeSection), [activeSection]);

  const searchWanted = (item: WantedLedgerItem) => {
    onSearchManagedReleases?.(item);
  };

  return (
    <Tabs
      value={active}
      onChange={(value) => {
        const next: AcquisitionSection = value === "usenet" || value === "torrent" || value === "vpn" || value === "downloads"
          ? value
          : "indexers";
        setActive(next);
        onSectionChange?.(next);
      }}
      keepMounted={false}
      data-testid="acquisition-control"
    >
      <Tabs.List aria-label="Acquisition setup and operations">
        <Tabs.Tab value="indexers">Indexers</Tabs.Tab>
        <Tabs.Tab value="usenet">Usenet</Tabs.Tab>
        <Tabs.Tab value="torrent">Torrents</Tabs.Tab>
        <Tabs.Tab value="vpn">VPN</Tabs.Tab>
        <Tabs.Tab value="downloads">Downloads</Tabs.Tab>
      </Tabs.List>
      <ErrorBoundary resetKey={active ?? ""} title="This acquisition section could not be displayed">
        <Tabs.Panel value="indexers" pt="md"><IndexersPanel /></Tabs.Panel>
        <Tabs.Panel value="usenet" pt="md"><ModuleSetupPanel module="usenet" /></Tabs.Panel>
        <Tabs.Panel value="torrent" pt="md"><ModuleSetupPanel module="torrent" /></Tabs.Panel>
        <Tabs.Panel value="vpn" pt="md"><ModuleSetupPanel module="vpn" /></Tabs.Panel>
        <Tabs.Panel value="downloads" pt="md">
          <Tabs defaultValue="queue" keepMounted={false}>
            <Tabs.List aria-label="Download operations">
              <Tabs.Tab value="queue">Queue</Tabs.Tab>
              <Tabs.Tab value="wanted">Wanted</Tabs.Tab>
            </Tabs.List>
            <Tabs.Panel value="queue" pt="md"><QueueView adminId={adminId} /></Tabs.Panel>
            <Tabs.Panel value="wanted" pt="md"><WantedView adminId={adminId} onSearchReleases={searchWanted} /></Tabs.Panel>
          </Tabs>
        </Tabs.Panel>
      </ErrorBoundary>
    </Tabs>
  );
}

function formatPlaybackTime(value: number): string {
  const total = Math.max(0, Math.floor(value / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function formatPlaybackBytes(value: number | null): string {
  if (value === null) return "Unavailable";
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function PlaybackControl({ onOpenTrace }: { readonly onOpenTrace?: () => void } = {}) {
  const query = useQuery({
    queryKey: ["admin", "playback"],
    queryFn: ({ signal }) => api.playbackAdmin({ signal }),
    retry: false,
    refetchInterval: 2_000,
    refetchIntervalInBackground: false,
  });
  const catalog = useQuery({ queryKey: ["library"], queryFn: api.browse, retry: false });
  const [draft, setDraft] = useState<PlaybackPolicy | null>(null);
  const [selectedFileId, setSelectedFileId] = useState("");
  const [previewNetwork, setPreviewNetwork] = useState<"local" | "remote">("local");
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof api.previewPlaybackDecision>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    if (query.data?.policy) setDraft((current) => current ?? query.data.policy);
  }, [query.data?.policy]);
  useEffect(() => {
    const first = catalog.data?.items[0]?.fileId;
    if (first) setSelectedFileId((current) => current || first);
  }, [catalog.data?.items]);

  if (query.isPending || !draft) return <LoadState label="Loading playback administration…" />;
  if (query.isError) return <ErrorState message={(query.error as Error).message} retry={() => void query.refetch()} />;

  const snapshot = query.data;
  const active = snapshot.sessions.filter((session) => session.state !== "ended");
  const updateDraft = <K extends keyof PlaybackPolicy>(key: K, value: PlaybackPolicy[K]) => {
    setDraft((current) => current ? { ...current, [key]: value } : current);
  };
  const applyPolicy = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const result = await api.updatePlaybackPolicy(draft);
      setDraft(result.policy);
      setNotice({ tone: "success", text: "Playback policy saved. New sessions use it immediately." });
      await query.refetch();
    } catch (error) {
      setNotice({ tone: "error", text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const stop = async (sessionId: string, transcodeOnly: boolean) => {
    const label = transcodeOnly ? "Stop this transcode and end its playback session?" : "Stop this playback session?";
    if (!window.confirm(label)) return;
    setBusy(true);
    setNotice(null);
    try {
      await api.stopPlaybackSession(sessionId, transcodeOnly);
      setNotice({ tone: "success", text: transcodeOnly ? "Transcode stopped." : "Playback session stopped." });
      await query.refetch();
    } catch (error) {
      setNotice({ tone: "error", text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack gap="lg" className="playback-control" data-testid="playback-control">
      <div className="playback-toolbar">
        <div>
          <Group gap="xs"><Title order={2}>{active.length} active sessions</Title><Text component="span" size="sm" c="dimmed">{active.filter((session) => session.workerAlive).length} transcoding</Text></Group>
          <Text size="xs" c="dimmed">Updated automatically every 2 seconds.</Text>
        </div>
        <Group gap="xs">
          <Text component="span" className="tantalar-inline-state" data-tone={snapshot.probe.available ? "success" : "error"}>{snapshot.probe.available ? "FFmpeg ready" : "FFmpeg missing"}</Text>
          <Button variant="default" size="compact-sm" onClick={() => void query.refetch()}>Refresh</Button>
        </Group>
      </div>

      <ActionNotice message={notice?.text} title="Playback" severity={notice?.tone} />

      <section className="playback-section" aria-labelledby="playback-sessions-heading">
        <Group justify="space-between" align="end">
          <div><Title order={3} id="playback-sessions-heading">Sessions</Title><Text size="sm" c="dimmed">Active players and sessions ended within the last hour. Filesystem paths are never shown.</Text></div>
          {onOpenTrace ? <Button variant="subtle" size="compact-sm" onClick={onOpenTrace}>Open Trace</Button> : null}
        </Group>
        <DenseGrid testId="playback-sessions-grid" ariaLabel="Playback sessions" data={snapshot.sessions} rowTestId={session => `playback-session-${session.sessionId}`} emptyMessage="No playback sessions."
          filters={[{ id: "state", label: "States", options: [...new Set(snapshot.sessions.map(session => session.state))].map(value => ({ value, label: value })) }]}
          columns={[
            { id: "title", header: "Title", accessorKey: "title", size: 250 },
            { id: "viewer", header: "Viewer", accessorKey: "viewer", size: 120 },
            { id: "client", header: "Client", accessorKey: "client", size: 180 },
            { id: "mode", header: "Mode", accessorKey: "mode", size: 80 },
            { id: "positionMs", header: "Position", accessorKey: "positionMs", size: 160, cell: ({ row }) => `${formatPlaybackTime(row.original.positionMs)} / ${formatPlaybackTime(row.original.durationMs)}`, meta: { dataType: "number" } },
            { id: "state", header: "State", accessorKey: "state", size: 100 },
            { id: "actions", header: "Actions", enableHiding: false, size: 280, cell: ({ row }) => { const session = row.original; return <>                    {session.state === "ended" ? <Text size="xs" c="dimmed">Ended {session.endedAt ? new Date(session.endedAt).toLocaleTimeString() : "recently"}</Text> : (
                      <Group gap={4} wrap="nowrap">
                        {session.workerAlive ? <Button color="red" variant="subtle" size="compact-xs" disabled={busy} onClick={() => void stop(session.sessionId, true)}>Stop transcode</Button> : null}
                        <Button color="red" variant="subtle" size="compact-xs" disabled={busy} onClick={() => void stop(session.sessionId, false)}>Stop session</Button>
                      </Group>
                    )}</>; } },
          ]}
        />
      </section>

      <section className="playback-section playback-policy" aria-labelledby="playback-policy-heading">
        <Title order={3} id="playback-policy-heading">Playback policy</Title>
        <Text size="sm" c="dimmed">Changes apply to new sessions. Current streams keep their existing settings.</Text>
        <div className="playback-policy__toggle">
          <Switch label="Prefer direct play" checked={draft.preferDirectPlay} onChange={(event) => updateDraft("preferDirectPlay", event.currentTarget.checked)} />
        </div>
        <SimpleGrid cols={{ base: 1, sm: 2 }} mt="md">
          <NumberInput label="Local bitrate ceiling (kbps)" min={500} max={200_000} step={500} value={draft.localBitrateKbps} onChange={(value) => updateDraft("localBitrateKbps", Number(value))} />
          <NumberInput label="Remote bitrate ceiling (kbps)" min={500} max={200_000} step={500} value={draft.remoteBitrateKbps} onChange={(value) => updateDraft("remoteBitrateKbps", Number(value))} />
          <NumberInput label="Maximum concurrent transcodes" min={1} max={32} value={draft.maxConcurrentTranscodes} onChange={(value) => updateDraft("maxConcurrentTranscodes", Number(value))} />
          <NativeSelect label="Hardware acceleration" value={draft.hardwareAcceleration} data={[
            { value: "auto", label: "Automatic safe default" },
            { value: "software", label: "Software only" },
            ...snapshot.probe.hardwareAcceleration.filter((value) => !["auto", "software"].includes(value)).map((value) => ({ value, label: value })),
          ]} onChange={(event) => updateDraft("hardwareAcceleration", event.currentTarget.value)} />
          <NativeSelect label="Subtitle handling" value={draft.subtitleMode} data={[
            { value: "manual", label: "Viewer chooses" },
            { value: "always", label: "Prefer saved language" },
            { value: "off", label: "Off by default" },
          ]} onChange={(event) => updateDraft("subtitleMode", event.currentTarget.value as PlaybackPolicy["subtitleMode"])} />
          <TextInput label="Default audio language" value={draft.defaultAudioLanguage} onChange={(event) => updateDraft("defaultAudioLanguage", event.currentTarget.value)} />
          <TextInput label="Default subtitle language" value={draft.defaultSubtitleLanguage} onChange={(event) => updateDraft("defaultSubtitleLanguage", event.currentTarget.value)} />
          <NumberInput label="Idle session timeout (seconds)" min={10} max={86_400} value={draft.idleTimeoutMs / 1000} onChange={(value) => updateDraft("idleTimeoutMs", Number(value) * 1000)} />
          <NumberInput label="Transcode cache limit (GB)" min={0.25} max={1024} decimalScale={2} value={draft.transcodeCacheMaxBytes / 1024 / 1024 / 1024} onChange={(value) => updateDraft("transcodeCacheMaxBytes", Math.round(Number(value) * 1024 * 1024 * 1024))} />
        </SimpleGrid>
        <Group className="playback-policy__actions" mt="md" justify="space-between">
          <Text size="xs" c="dimmed">{formatPlaybackBytes(snapshot.storage.freeBytes)} free on the contained Tantalar data volume.</Text>
          <Button disabled={busy || !snapshot.probe.available} loading={busy} onClick={() => void applyPolicy()}>Apply policy</Button>
        </Group>
        {!snapshot.probe.available ? <Text role="alert" size="sm" c="red" mt="xs">Install FFmpeg before applying playback policy.</Text> : null}
      </section>

      <section className="playback-section playback-check" aria-labelledby="playback-preview-heading">
        <Title order={3} id="playback-preview-heading">Playback compatibility check</Title>
        <Text size="sm" c="dimmed">Check whether Tantalar will direct play or transcode a title. This does not start playback.</Text>
        <Group className="playback-check__controls" mt="md" align="end" grow>
          <NativeSelect label="Catalog item" value={selectedFileId} data={(catalog.data?.items ?? []).map((item) => ({ value: item.fileId, label: item.title }))} onChange={(event) => setSelectedFileId(event.currentTarget.value)} />
          <NativeSelect label="Client network" value={previewNetwork} data={[{ value: "local", label: "Local" }, { value: "remote", label: "Remote" }]} onChange={(event) => setPreviewNetwork(event.currentTarget.value as "local" | "remote")} />
          <Button variant="default" disabled={!selectedFileId || busy} onClick={() => void api.previewPlaybackDecision(selectedFileId, previewNetwork).then(setPreview).catch((error: Error) => setNotice({ tone: "error", text: error.message }))}>Check playback</Button>
        </Group>
        {preview ? (
          <dl className="playback-preview" aria-live="polite">
            <div><dt>Decision</dt><dd>{preview.mode === "direct" ? "Direct play" : "HLS transcode"}</dd></div>
            <div><dt>Reason</dt><dd>{preview.reason}</dd></div>
            <div><dt>Video</dt><dd>{preview.video}</dd></div>
            <div><dt>Audio</dt><dd>{preview.audio}</dd></div>
            <div><dt>Applied ceiling</dt><dd className="playback-number">{preview.maxBitrateKbps.toLocaleString()} kbps</dd></div>
          </dl>
        ) : null}
      </section>

      <details className="playback-advanced">
        <summary>Advanced FFmpeg details</summary>
        <Text size="sm" mt="sm">{snapshot.probe.version ?? "FFmpeg is unavailable."}</Text>
        <Text size="xs" c="dimmed" mt="xs">Hardware acceleration: {snapshot.probe.hardwareAcceleration.join(", ") || "none reported"}</Text>
        <Text size="xs" c="dimmed">Encoders: {snapshot.probe.encoders.join(", ") || "none reported"}</Text>
      </details>
    </Stack>
  );
}

const AUTOMATION_NAMES: Record<string, string> = {
  "dev.tantalar.plugin.series": "Series monitoring",
  "dev.tantalar.plugin.movies": "Movie monitoring",
};

export function AutomationControl() {
  const query = useQuery({ queryKey: ["admin", "plugins"], queryFn: api.plugins, retry: false });
  if (query.isPending) return <LoadState label="Checking automation modules…" />;
  if (query.isError) return <ErrorState message={(query.error as Error).message} retry={() => void query.refetch()} />;

  const providers = query.data.plugins.filter((plugin) =>
    plugin.manifest.provides.some((capability) => capability.startsWith("dev.tantalar.capability.automation.")),
  );
  return (
    <Stack gap="md" data-testid="automation-control">
      <Alert color="blue" title="Automation means rules and scheduled work">
        Activity and audit records belong in their own logs. This area will control what Tantalar monitors, when it searches and how it reacts.
      </Alert>
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <Paper withBorder p="lg" radius="md">
          <Group justify="space-between"><Title order={3}>Rule providers</Title><Text size="sm" c="dimmed">{providers.length}</Text></Group>
          {providers.length === 0 ? (
            <Text c="dimmed" mt="sm">No movie or series automation provider is mounted.</Text>
          ) : (
            <Stack gap="xs" mt="sm">
              {providers.map((plugin) => (
                <Group key={plugin.manifest.id} justify="space-between">
                  <Text>{AUTOMATION_NAMES[plugin.manifest.id] ?? plugin.manifest.id}</Text>
                  <Text component="span" className="tantalar-inline-state" data-tone={plugin.state === "healthy" || plugin.state === "running" ? "success" : "warning"}>{plugin.state}</Text>
                </Group>
              ))}
            </Stack>
          )}
        </Paper>
        <Paper withBorder p="lg" radius="md">
          <Title order={3}>Scheduled work</Title>
          <Text component="p" className="tantalar-inline-state" data-tone="neutral" mt="sm">Not configurable</Text>
          <Text c="dimmed" mt="sm">The runtime scheduler runs internally, but this alpha has no API for viewing or editing schedules.</Text>
        </Paper>
      </SimpleGrid>
      <Paper className="tantalar-honest-state" withBorder p="lg" radius="md">
        <Title order={4}>Rule editor not available yet</Title>
        <Text c="dimmed" mt={6}>Monitoring rules, search intervals, retries and upgrade policies need a dedicated runtime contract before the interface can edit them safely.</Text>
      </Paper>
    </Stack>
  );
}
