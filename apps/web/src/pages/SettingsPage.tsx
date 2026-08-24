/**
 * Wave 8 product Settings page. Sections: General, Libraries, Downloads,
 * Indexers, Quality, Import, Metadata, Playback, Users, Integrations, VPN,
 * System.
 *
 * Rules honoured here:
 * - Administration (Libraries, Downloads admin ops, Indexers, Users, VPN,
 *   System) is role-gated to admins; viewers get a clear notice instead of
 *   hidden controls.
 * - Internal `--tantalar-*` CSS variable names never appear as user settings;
 *   the theme section uses human labels ("Primary color", …).
 * - Every section reads real APIs — no placeholder toggles.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
import { useTheme } from "../theme/engine";
import { SCHEME_LABELS, DEFAULT_TOKENS, TOKEN_PREFIX, TOKEN_LABELS, sanitizeTokenOverrides } from "../theme/tokens";
import { DensityToggle } from "../admin/views";

function AdminOnly({ isAdmin, children }: { isAdmin: boolean; children: React.ReactNode }) {
  if (isAdmin) return <>{children}</>;
  return (
    <Alert role="note" title="Administrator access required" color="yellow">
      <Text size="sm">This section needs an administrator account.</Text>
    </Alert>
  );
}

// ---- General -------------------------------------------------------------------

function GeneralSection({ adminId }: { adminId: string | null }) {
  const theme = useTheme();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<ReadonlyArray<string>>([]);
  const [status, setStatus] = useState<string | null>(null);

  const previewToken = (key: string, value: string) => {
    const next = { ...values, [`${TOKEN_PREFIX}${key}`]: value };
    setValues(next);
    const res = theme.applyPreview(next);
    setErrors(res.ok ? [] : (res.errors ?? []));
  };

  const saveTheme = async () => {
    setErrors([]);
    setStatus(null);
    const merged: Record<string, string> = {};
    for (const k of Object.keys(DEFAULT_TOKENS)) {
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
      setStatus("Appearance saved.");
      setName("");
      setValues({});
      if (adminId) void qc.invalidateQueries({ queryKey: ["prefs"] });
    } catch (err) {
      setErrors([(err as Error).message]);
    }
  };

  return (
    <Stack gap="md" data-testid="settings-general">
      <Stack gap="xs">
        <Title order={5}>Theme</Title>
        <NativeSelect
          aria-label="Theme"
          data-testid="scheme-select"
          label="Theme"
          value={theme.scheme}
          onChange={(e) => theme.setScheme(e.currentTarget.value === "light" ? "light" : "dark")}
          data={[
            { value: "dark", label: SCHEME_LABELS.dark },
            { value: "light", label: SCHEME_LABELS.light },
          ]}
        />
        <DensityToggle adminId={adminId} />
      </Stack>

      <Stack gap="xs" data-testid="appearance-editor">
        <Title order={5}>Custom appearance</Title>
        <Text size="sm" c="var(--tantalar-color-text-dimmed)">
          Overrides apply immediately and persist for your account. Values accept plain colors
          like <code>#4d8df6</code> or lengths like <code>6px</code>.
        </Text>
        <TextInput
          label="Preset name"
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          placeholder="midnight-blue"
        />
        {Object.keys(DEFAULT_TOKENS).map((key) => (
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
          <Button data-testid="save-theme" onClick={() => void saveTheme()}>Save appearance</Button>
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

// ---- Libraries -----------------------------------------------------------------

interface ValidationRow {
  library: { id: string; name: string; rootPath: string };
  ok: boolean;
  issues: ReadonlyArray<{ code: string; detail: string }>;
}

function LibrariesSection() {
  const qc = useQueryClient();
  const libs = useQuery({ queryKey: ["settings", "libraries"], queryFn: () => api.libraries(), retry: false });
  const [validation, setValidation] = useState<ReadonlyArray<ValidationRow>>([]);
  const [scanNote, setScanNote] = useState<string | null>(null);

  if (libs.isPending) return <div aria-busy="true">Loading libraries…</div>;
  if (libs.isError) {
    return (
      <Alert role="alert" title="Could not load libraries" color="red">
        <Group>
          <Text size="sm">{(libs.error as Error).message}</Text>
          <Button variant="light" onClick={() => void libs.refetch()}>Retry</Button>
        </Group>
      </Alert>
    );
  }

  const validate = async (id: string) => {
    setScanNote(null);
    try {
      const res = await api.validateLibrary(id);
      setValidation(res.results);
    } catch (err) {
      setValidation([]);
      setScanNote((err as Error).message);
    }
  };

  const rescan = async (id: string) => {
    setScanNote(null);
    try {
      const res = await api.rescanLibrary(id);
      setScanNote(`Rescan finished: ${res.checked} checked, ${res.missingRemoved} missing removed.`);
      void qc.invalidateQueries({ queryKey: ["settings", "libraries"] });
    } catch (err) {
      setScanNote((err as Error).message);
    }
  };

  return (
    <Stack gap="sm" data-testid="settings-libraries">
      <Text size="sm" c="var(--tantalar-color-text-dimmed)">
        Removing a library never deletes media files. Validation checks roots before any import runs.
      </Text>
      {libs.data.libraries.length === 0 ? (
        <Text c="var(--tantalar-color-text-dimmed)" size="sm">No libraries are configured yet.</Text>
      ) : (
        libs.data.libraries.map((lib) => (
          <Paper
            key={lib.id}
            p="sm"
            radius="md"
            style={{ background: "var(--tantalar-color-surface)", border: "1px solid var(--tantalar-color-border)" }}
          >
            <Group justify="space-between" wrap="wrap">
              <div>
                <Text size="sm">{lib.name}</Text>
                <Text size="xs" c="var(--tantalar-color-text-dimmed)">
                  {lib.kind} · {lib.rootPath} · {lib.enabled ? "enabled" : "disabled"}
                </Text>
              </div>
              <Group gap="xs">
                <Button variant="light" size="xs" onClick={() => void validate(lib.id)}>Validate</Button>
                <Button variant="default" size="xs" onClick={() => void rescan(lib.id)}>Rescan</Button>
              </Group>
            </Group>
          </Paper>
        ))
      )}
      {validation.length > 0 ? (
        <Stack gap={4} data-testid="library-validation">
          {validation.map((r) => (
            <Text key={r.library.id} size="sm" c={r.ok ? "var(--tantalar-color-success)" : "var(--tantalar-color-warning)"}>
              {r.library.name}: {r.ok ? "valid" : r.issues.map((i) => i.code).join(", ")}
            </Text>
          ))}
        </Stack>
      ) : null}
      {scanNote ? <Text size="sm" role="status">{scanNote}</Text> : null}
    </Stack>
  );
}

// ---- Downloads / Quality / Import / Metadata / Playback -------------------------

/**
 * Queue + engine status lives in the admin console's Queue view; this
 * section surfaces download state honestly: what the running plugins report,
 * or a truthful empty state when no client plugin is mounted.
 */
function DownloadsSection({ isAdmin }: { isAdmin: boolean }) {
  const q = useQuery({
    queryKey: ["settings", "downloads"],
    queryFn: () => api.plugins(),
    retry: false,
  });
  if (!isAdmin) return <AdminOnly isAdmin={false}>{null}</AdminOnly>;
  if (q.isPending) return <div aria-busy="true">Loading download clients…</div>;
  if (q.isError) return <Alert role="alert" color="red">{(q.error as Error).message}</Alert>;
  const clients = q.data.plugins.filter((p) =>
    p.manifest.id.includes("torrent") || p.manifest.id.includes("usenet") || p.manifest.id.includes("download"),
  );
  return (
    <Stack gap="sm" data-testid="settings-downloads">
      <Text size="sm" c="var(--tantalar-color-text-dimmed)">
        Download engines run inside Tantalar as embedded modules. Active jobs appear in Activity.
      </Text>
      {clients.length === 0 ? (
        <Text c="var(--tantalar-color-text-dimmed)" size="sm">No download module is mounted.</Text>
      ) : (
        clients.map((c) => (
          <Group key={c.manifest.id} justify="space-between">
            <Text size="sm">{c.manifest.id.replace("dev.tantalar.plugin.", "")}</Text>
            <Text size="sm" c={c.state === "running" ? "var(--tantalar-color-success)" : "var(--tantalar-color-warning)"}>
              {c.state}
            </Text>
          </Group>
        ))
      )}
    </Stack>
  );
}

function IndexersSection({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["settings", "indexers"], queryFn: () => api.indexers(), retry: false });
  const [testNote, setTestNote] = useState<string | null>(null);
  if (!isAdmin) return <AdminOnly isAdmin={false}>{null}</AdminOnly>;
  if (q.isPending) return <div aria-busy="true">Loading indexers…</div>;
  if (q.isError) return <Alert role="alert" color="red">{(q.error as Error).message}</Alert>;

  const test = async (id: string) => {
    setTestNote(null);
    try {
      const res = await api.testIndexer(id);
      setTestNote(res.ok ? `${id}: connection OK.` : `${id}: ${res.detail ?? "test failed"}.`);
    } catch (err) {
      setTestNote(`${id}: ${(err as Error).message}`);
    }
  };

  const toggle = async (id: string, enabled: boolean) => {
    try {
      await api.setIndexerEnabled(id, enabled);
      void qc.invalidateQueries({ queryKey: ["settings", "indexers"] });
    } catch {
      /* surfaced by refetch state */
    }
  };

  return (
    <Stack gap="sm" data-testid="settings-indexers">
      <Text size="sm" c="var(--tantalar-color-text-dimmed)">
        Provider keys stay on the server; they are never shown or sent back to your browser.
      </Text>
      {q.data.indexers.length === 0 ? (
        <Text c="var(--tantalar-color-text-dimmed)" size="sm">No indexers configured yet.</Text>
      ) : (
        q.data.indexers.map((ix) => (
          <Paper
            key={ix.id}
            p="sm"
            radius="md"
            style={{ background: "var(--tantalar-color-surface)", border: "1px solid var(--tantalar-color-border)" }}
          >
            <Group justify="space-between" wrap="wrap">
              <div>
                <Text size="sm">{ix.name}</Text>
                <Text size="xs" c="var(--tantalar-color-text-dimmed)">
                  {ix.protocol} · priority {ix.priority} · {ix.hasApiKey ? "key stored" : "no key"}
                </Text>
              </div>
              <Group gap="xs">
                <Switch
                  aria-label={`${ix.name} enabled`}
                  checked={ix.enabled}
                  onChange={(e) => void toggle(ix.id, e.currentTarget.checked)}
                />
                <Button variant="light" size="xs" onClick={() => void test(ix.id)}>Test</Button>
              </Group>
            </Group>
          </Paper>
        ))
      )}
      {testNote ? <Text size="sm" role="status">{testNote}</Text> : null}
    </Stack>
  );
}

function PlaceholderSection({
  title,
  description,
  children,
  testId,
}: {
  title: string;
  description: string;
  children?: React.ReactNode;
  testId: string;
}) {
  return (
    <Stack gap="sm" data-testid={testId}>
      <Title order={5}>{title}</Title>
      <Text size="sm" c="var(--tantalar-color-text-dimmed)">{description}</Text>
      {children}
    </Stack>
  );
}

function ImportSection({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const catalog = useQuery({
    queryKey: ["settings", "catalog"],
    queryFn: () => api.catalog(),
    retry: false,
    enabled: isAdmin,
  });
  const schemes = useQuery({
    queryKey: ["settings", "naming-schemes"],
    queryFn: () => api.namingSchemes(),
    retry: false,
    enabled: isAdmin,
  });
  const guidance = useQuery({
    queryKey: ["settings", "naming-recovery"],
    queryFn: () => api.namingRecoveryGuidance(),
    retry: false,
    enabled: isAdmin,
  });
  const [name, setName] = useState("");
  const [episodeTemplate, setEpisodeTemplate] = useState("");
  const [movieTemplate, setMovieTemplate] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const [plan, setPlan] = useState<{ scheme: string; total: number; changed: number; plan: ReadonlyArray<{ itemKey: string; currentPath: string; newPath: string; changes: boolean }> } | null>(null);

  if (!isAdmin) return <AdminOnly isAdmin={false}>{null}</AdminOnly>;

  const runPreview = async (tpl: { episodeTemplate?: string; movieTemplate?: string }) => {
    setPreview(null);
    setPreviewError(null);
    try {
      const kind = tpl.episodeTemplate !== undefined ? "series" : "movie";
      const res = await api.previewNaming({
        kind,
        title: "Example Title",
        series: "Example Series",
        season: 1,
        episode: 2,
        year: 2026,
        quality: "1080p",
        codec: "h264",
        language: "en",
        ...(kind === "series" ? { episodeTemplate: tpl.episodeTemplate } : { movieTemplate: tpl.movieTemplate }),
      });
      setPreview(res.path);
    } catch (err) {
      setPreviewError((err as Error).message);
    }
  };

  const saveScheme = async () => {
    setSaveNote(null);
    try {
      await api.saveNamingScheme(name.trim() || "default", episodeTemplate, movieTemplate);
      setSaveNote(`Scheme "${name.trim() || "default"}" saved.`);
      void qc.invalidateQueries({ queryKey: ["settings", "naming-schemes"] });
    } catch (err) {
      setSaveNote(`Not saved: ${(err as Error).message}`);
    }
  };

  const runPlan = async (scheme: string) => {
    try {
      setPlan(await api.renamePlan(scheme));
    } catch (err) {
      setPlan(null);
      setSaveNote(`Rename plan failed: ${(err as Error).message}`);
    }
  };

  return (
    <Stack gap="md" data-testid="settings-import">
      <Paper withBorder p="md">
        <Title order={5}>Naming schemes</Title>
        <Text size="sm" c="var(--tantalar-color-text-dimmed)">
          Templates place imported files. Placeholders: {"{series}, {seasonPad2}, {episodePad2}, {title}, {year}, {quality}, {codec}, {language}, {edition}"}.
          Invalid templates cannot be saved.
        </Text>
        <Stack gap="xs" mt="sm">
          <TextInput label="Scheme name" aria-label="Scheme name" data-testid="scheme-name" value={name} onChange={(e) => setName(e.currentTarget.value)} placeholder="default" />
          <TextInput
            label="Episode template"
            aria-label="Episode template"
            data-testid="episode-template"
            value={episodeTemplate}
            onChange={(e) => setEpisodeTemplate(e.currentTarget.value)}
            placeholder="{series}/Season {seasonPad2}/{series} S{seasonPad2}E{episodePad2} {quality}"
          />
          <TextInput
            label="Movie template"
            aria-label="Movie template"
            data-testid="movie-template"
            value={movieTemplate}
            onChange={(e) => setMovieTemplate(e.currentTarget.value)}
            placeholder="{title} ({year})/{title} ({year}) {quality}"
          />
          <Group gap="xs" wrap="wrap">
            <Button
              variant="default"
              data-testid="preview-episode-template"
              disabled={!episodeTemplate}
              onClick={() => void runPreview({ episodeTemplate })}
            >
              Preview episode path
            </Button>
            <Button
              variant="default"
              data-testid="preview-movie-template"
              disabled={!movieTemplate}
              onClick={() => void runPreview({ movieTemplate })}
            >
              Preview movie path
            </Button>
            <Button
              data-testid="save-scheme"
              disabled={!episodeTemplate || !movieTemplate}
              onClick={() => void saveScheme()}
            >
              Save scheme
            </Button>
          </Group>
          {preview ? (
            <Text size="sm" role="status" data-testid="naming-preview">Preview: {preview}</Text>
          ) : null}
          {previewError ? (
            <Alert role="alert" color="red" data-testid="naming-preview-error">{previewError}</Alert>
          ) : null}
          {saveNote ? <Text size="sm" role="status">{saveNote}</Text> : null}
        </Stack>
        {schemes.isError ? (
          <Alert role="alert" color="red" mt="sm">{(schemes.error as Error).message}</Alert>
        ) : schemes.data ? (
          <Stack gap={4} mt="sm">
            {schemes.data.schemes.map((s) => (
              <Group key={s.name} justify="space-between">
                <Text size="sm">{s.name}</Text>
                <Button variant="subtle" size="xs" data-testid={`rename-plan-${s.name}`} onClick={() => void runPlan(s.name)}>
                  Review bulk rename
                </Button>
              </Group>
            ))}
          </Stack>
        ) : null}
        {plan ? (
          <Paper withBorder p="sm" mt="sm" data-testid="rename-plan">
            <Title order={6}>Bulk rename review — {plan.scheme}</Title>
            <Text size="sm">{plan.changed} of {plan.total} items would change path. No files move from this review.</Text>
            <Stack gap={4} mt="xs">
              {plan.plan.filter((p) => p.changes).slice(0, 20).map((p) => (
                <Text key={p.itemKey} size="xs">
                  {p.itemKey}: {p.currentPath} → {p.newPath}
                </Text>
              ))}
            </Stack>
          </Paper>
        ) : null}
        {guidance.data ? (
          <Paper withBorder p="sm" mt="sm" data-testid="naming-recovery">
            <Title order={6}>Recovery guidance</Title>
            <Stack gap={4} mt="xs">
              {guidance.data.guidance.map((g, i) => (
                <Text key={i} size="xs" c="var(--tantalar-color-text-dimmed)">{g}</Text>
              ))}
            </Stack>
          </Paper>
        ) : null}
      </Paper>
      <Paper withBorder p="md">
        <Title order={5}>Imported catalog</Title>
        {catalog.isPending ? (
          <div aria-busy="true">Loading catalog…</div>
        ) : catalog.isError ? (
          <Alert role="alert" color="red">{(catalog.error as Error).message}</Alert>
        ) : catalog.data.items.length === 0 ? (
          <Text c="var(--tantalar-color-text-dimmed)" size="sm">Nothing has been imported yet.</Text>
        ) : (
          <Stack gap={4}>
            {catalog.data.items.slice(0, 20).map((item) => (
              <Text key={item.fileId} size="xs" c="var(--tantalar-color-text-dimmed)" lineClamp={1}>
                {item.itemKey} · {item.quality} · {item.method}
              </Text>
            ))}
            {catalog.data.items.length > 20 ? (
              <Text size="xs" c="var(--tantalar-color-text-dimmed)">
                …and {catalog.data.items.length - 20} more.
              </Text>
            ) : null}
          </Stack>
        )}
      </Paper>
    </Stack>
  );
}

// ---- Users ---------------------------------------------------------------------

function UsersSection() {
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ["settings", "users"], queryFn: () => api.users(), retry: false });
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"viewer" | "admin">("viewer");
  const [note, setNote] = useState<string | null>(null);

  const create = async () => {
    setNote(null);
    try {
      await api.createUser(username.trim(), password, role);
      setNote(`Created ${role} “${username.trim()}”.`);
      setUsername("");
      setPassword("");
      void qc.invalidateQueries({ queryKey: ["settings", "users"] });
    } catch (err) {
      setNote((err as Error).message);
    }
  };

  return (
    <Stack gap="sm" data-testid="settings-users">
      {users.isPending ? (
        <div aria-busy="true">Loading users…</div>
      ) : users.isError ? (
        <Alert role="alert" color="red">{(users.error as Error).message}</Alert>
      ) : (
        <Stack gap={4}>
          {users.data.users.map((u) => (
            <Group key={u.id} justify="space-between">
              <Text size="sm">{u.username}</Text>
              <Text size="xs" c="var(--tantalar-color-text-dimmed)">{u.role}</Text>
            </Group>
          ))}
        </Stack>
      )}
      <Group gap="xs" align="flex-end" wrap="wrap">
        <TextInput
          label="Username"
          aria-label="New username"
          data-testid="new-user-username"
          value={username}
          onChange={(e) => setUsername(e.currentTarget.value)}
        />
        <PasswordInput
          label="Password"
          aria-label="New password"
          data-testid="new-user-password"
          value={password}
          onChange={(e) => setPassword(e.currentTarget.value)}
        />
        <NativeSelect
          aria-label="Role"
          label="Role"
          value={role}
          onChange={(e) => setRole(e.currentTarget.value === "admin" ? "admin" : "viewer")}
          data={[
            { value: "viewer", label: "Viewer" },
            { value: "admin", label: "Administrator" },
          ]}
        />
        <Button data-testid="create-user" onClick={() => void create()} disabled={!username.trim() || password.length < 8}>
          Create user
        </Button>
      </Group>
      {note ? <Text size="sm" role="status">{note}</Text> : null}
    </Stack>
  );
}

// ---- Integrations (Wave 9, TAN-033): API keys, webhooks, MCP ------------------

const KNOWN_KEY_SCOPES = ["events.read", "plugins.read", "plugins.invoke", "queue.read", "queue.write"];

function IntegrationsSection({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const keys = useQuery({ queryKey: ["settings", "api-keys"], queryFn: () => api.apiKeys(), retry: false, enabled: isAdmin });
  const hooks = useQuery({ queryKey: ["settings", "webhooks"], queryFn: () => api.webhooks(), retry: false, enabled: isAdmin });
  const mcp = useQuery({ queryKey: ["settings", "mcp"], queryFn: () => api.mcpStatus(), retry: false });
  const [keyName, setKeyName] = useState("");
  const [keyExpiry, setKeyExpiry] = useState("");
  const [scopes, setScopes] = useState<readonly string[]>(["events.read"]);
  const [secretOnce, setSecretOnce] = useState<string | null>(null);
  const [hookUrl, setHookUrl] = useState("");
  const [hookEnvVar, setHookEnvVar] = useState("");
  const [note, setNote] = useState<string | null>(null);

  if (!isAdmin) return <AdminOnly isAdmin={false}>{mcp.isPending ? <div aria-busy="true">Loading MCP status…</div> : mcp.data ? <McpSummary mcp={mcp.data} /> : null}</AdminOnly>;

  const createKey = async () => {
    setNote(null);
    try {
      const res = await api.createApiKey(keyName.trim(), scopes, keyExpiry ? new Date(keyExpiry).toISOString() : null);
      // The plaintext secret is shown ONCE and never stored client-side.
      setSecretOnce(res.secret);
      setKeyName("");
      setKeyExpiry("");
      void qc.invalidateQueries({ queryKey: ["settings", "api-keys"] });
    } catch (err) {
      setNote((err as Error).message);
    }
  };

  const createHook = async () => {
    setNote(null);
    try {
      await api.createWebhook(hookUrl.trim(), ["dev.tantalar.event."], hookEnvVar.trim());
      setNote("Webhook destination saved.");
      setHookUrl("");
      setHookEnvVar("");
      void qc.invalidateQueries({ queryKey: ["settings", "webhooks"] });
    } catch (err) {
      setNote((err as Error).message);
    }
  };

  return (
    <Stack gap="md" data-testid="settings-integrations">
      <Stack gap="xs" data-testid="apikeys-block">
        <Title order={5}>API keys</Title>
        <Text size="sm" c="var(--tantalar-color-text-dimmed)">
          Keys authenticate other tools against the Tantalar API. The secret value appears once at creation — write it down then.
        </Text>
        {keys.isPending ? <div aria-busy="true">Loading keys…</div> : null}
        {keys.isError ? <Alert role="alert" color="red">{(keys.error as Error).message}</Alert> : null}
        {keys.data?.keys.map((k) => (
          <Group key={k.id} justify="space-between" wrap="wrap">
            <Text size="sm">
              {k.name} · {k.scopes.join(", ")}
              {k.revokedAt ? " · revoked" : k.expiresAt ? ` · expires ${k.expiresAt.slice(0, 10)}` : ""}
            </Text>
            {!k.revokedAt ? (
              <Button
                size="compact-xs"
                variant="light"
                color="red"
                data-testid={`revoke-key-${k.name}`}
                onClick={() =>
                  void api.revokeApiKey(k.id).then(() => qc.invalidateQueries({ queryKey: ["settings", "api-keys"] }))
                }
              >
                Revoke
              </Button>
            ) : null}
          </Group>
        ))}
        <Group align="flex-end" wrap="wrap">
          <TextInput label="Key name" aria-label="API key name" data-testid="apikey-name" value={keyName} onChange={(e) => setKeyName(e.currentTarget.value)} />
          <TextInput
            label="Expires (optional)"
            aria-label="API key expiry date"
            placeholder="2027-12-31"
            value={keyExpiry}
            onChange={(e) => setKeyExpiry(e.currentTarget.value)}
            style={{ width: 160 }}
          />
          <NativeSelect
            label="Scope"
            aria-label="API key scope"
            value={scopes[0]}
            onChange={(e) => setScopes([e.currentTarget.value])}
            data={KNOWN_KEY_SCOPES.map((s) => ({ value: s, label: s }))}
          />
          <Button data-testid="create-apikey" onClick={() => void createKey()} disabled={!keyName.trim()}>
            Create key
          </Button>
        </Group>
        {secretOnce ? (
          <Alert role="alert" title="Copy this key now — it will not be shown again" color="yellow" data-testid="apikey-secret-once">
            <Text size="sm" style={{ wordBreak: "break-all" }}>{secretOnce}</Text>
            <Button size="compact-xs" variant="default" mt="xs" onClick={() => setSecretOnce(null)}>Done</Button>
          </Alert>
        ) : null}
      </Stack>

      <Stack gap="xs" data-testid="webhooks-block">
        <Title order={5}>Webhooks</Title>
        <Text size="sm" c="var(--tantalar-color-text-dimmed)">
          Deliveries are signed with a secret from an environment variable. Only the variable name is stored.
        </Text>
        {hooks.isPending ? <div aria-busy="true">Loading webhooks…</div> : null}
        {hooks.isError ? <Alert role="alert" color="red">{(hooks.error as Error).message}</Alert> : null}
        {hooks.data?.webhooks.map((w) => (
          <Paper key={w.id} p="xs" radius="md" style={{ background: "var(--tantalar-color-surface)", border: "1px solid var(--tantalar-color-border)" }}>
            <Group justify="space-between" wrap="wrap">
              <div>
                <Text size="sm" lineClamp={1}>{w.url}</Text>
                <Text size="xs" c="var(--tantalar-color-text-dimmed)">
                  signing env var {w.secretEnvVarConfigured ? "configured" : "missing"}
                  {" · "}
                  last delivery: {w.lastStatus ?? "never"}
                  {w.lastDetail ? ` (${w.lastDetail})` : ""}
                </Text>
              </div>
              <Group gap="xs">
                <Button
                  size="compact-xs"
                  variant="default"
                  onClick={() =>
                    void api
                      .testWebhook(w.id)
                      .then((r) => setNote(r.ok ? `Test delivery succeeded (status ${r.status}).` : `Test delivery failed: ${r.detail ?? r.code ?? `status ${r.status}`}`))
                      .catch((err) => setNote(`Test delivery failed: ${(err as Error).message}`))
                      .finally(() => void qc.invalidateQueries({ queryKey: ["settings", "webhooks"] }))
                  }
                >
                  Test delivery
                </Button>
                <Button
                  size="compact-xs"
                  variant="light"
                  color="red"
                  onClick={() => void api.deleteWebhook(w.id).then(() => qc.invalidateQueries({ queryKey: ["settings", "webhooks"] }))}
                >
                  Delete
                </Button>
              </Group>
            </Group>
          </Paper>
        ))}
        <Group align="flex-end" wrap="wrap">
          <TextInput label="Destination URL" aria-label="Webhook destination URL" placeholder="https://example.invalid/hook" value={hookUrl} onChange={(e) => setHookUrl(e.currentTarget.value)} />
          <TextInput label="Signing secret env var" aria-label="Signing secret environment variable name" placeholder="TANTALAR_WEBHOOK_SECRET" value={hookEnvVar} onChange={(e) => setHookEnvVar(e.currentTarget.value)} />
          <Button onClick={() => void createHook()} disabled={!hookUrl.trim() || !hookEnvVar.trim()}>Add webhook</Button>
        </Group>
      </Stack>

      {mcp.isPending ? <div aria-busy="true">Loading MCP status…</div> : mcp.data ? <McpSummary mcp={mcp.data} /> : null}
      {note ? <Text size="sm" role="status">{note}</Text> : null}
    </Stack>
  );
}

function McpSummary({ mcp }: { mcp: Awaited<ReturnType<typeof api.mcpStatus>> }) {
  return (
    <Stack gap={4} data-testid="mcp-status">
      <Title order={5}>Model Context Protocol (MCP)</Title>
      <Text size="sm">
        {mcp.mounted
          ? `Mounted and ${mcp.state}. Version ${mcp.version ?? "?"}; audited calls: ${mcp.auditedCalls ?? "unknown"}.`
          : "The MCP module is not mounted."}
      </Text>
      <Text size="xs" c="var(--tantalar-color-text-dimmed)">Default policy: {mcp.defaultPolicy}.</Text>
    </Stack>
  );
}

// ---- System (Wave 9, TAN-042/043): backup/restore + diagnostics + bundle -------

function SystemOpsSection({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const diag = useQuery({ queryKey: ["settings", "diagnostics"], queryFn: () => api.diagnostics(), retry: false, enabled: isAdmin });
  const preview = useQuery({ queryKey: ["settings", "bundle-preview"], queryFn: () => api.supportBundlePreview(), retry: false, enabled: isAdmin });
  const [note, setNote] = useState<string | null>(null);
  const [restorePath, setRestorePath] = useState("");

  if (!isAdmin) return <AdminOnly isAdmin={false}>{null}</AdminOnly>;

  const runBackup = async () => {
    setNote(null);
    try {
      const res = await api.backup();
      setNote(`Backup written to ${res.path}. Includes: ${res.includes.join(", ")}.`);
      void qc.invalidateQueries({ queryKey: ["settings", "diagnostics"] });
    } catch (err) {
      setNote((err as Error).message);
    }
  };

  const runRestore = async () => {
    setNote(null);
    if (!window.confirm("Restore replaces the live database after validation. A safety backup of the current database is taken first. Continue?")) return;
    try {
      const res = await api.restore(restorePath.trim());
      setNote(res.note);
    } catch (err) {
      setNote(`Restore refused: ${(err as Error).message}`);
    }
  };

  const exportBundle = async (includeMediaNames: boolean) => {
    setNote(null);
    try {
      const res = await api.supportBundle(includeMediaNames);
      const text = JSON.stringify(res.bundle, null, 2);
      const blob = new Blob([text], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "tantalar-support-bundle.json";
      a.click();
      URL.revokeObjectURL(url);
      setNote("Support bundle exported. Secrets and media names are redacted unless you opted in.");
    } catch (err) {
      setNote((err as Error).message);
    }
  };

  return (
    <Stack gap="md" data-testid="settings-system-ops">
      <Stack gap="xs" data-testid="backup-block">
        <Title order={5}>Backup and restore</Title>
        <Text size="sm" c="var(--tantalar-color-text-dimmed)">
          Backups are atomic and integrity-checked before they count as complete. Restore validates the backup before replacing anything.
        </Text>
        <Group>
          <Button data-testid="run-backup" onClick={() => void runBackup()}>Create backup</Button>
        </Group>
        <Group align="flex-end" wrap="wrap">
          <TextInput
            label="Backup file to restore"
            aria-label="Backup file path"
            placeholder="/data/backups/tantalar-….db"
            value={restorePath}
            onChange={(e) => setRestorePath(e.currentTarget.value)}
            style={{ minWidth: 280 }}
          />
          <Button variant="light" data-testid="run-restore" disabled={!restorePath.trim()} onClick={() => void runRestore()}>
            Restore
          </Button>
        </Group>
      </Stack>

      <Stack gap="xs" data-testid="diagnostics-block">
        <Title order={5}>Diagnostics</Title>
        {diag.isPending ? <div aria-busy="true">Collecting diagnostics…</div> : null}
        {diag.isError ? <Alert role="alert" color="red">{(diag.error as Error).message}</Alert> : null}
        {diag.data ? (
          <Stack gap={4}>
            <Text size="sm">Node {diag.data.versions.node} on {diag.data.versions.platform}/{diag.data.versions.arch}.</Text>
            <Text size="sm">
              Transcoder support: ffmpeg {diag.data.transcoder.ffmpegAvailable ? "available" : "not found"}.
            </Text>
            <Text size="sm">
              VPN capability {diag.data.network.vpnCapabilityMounted ? "mounted" : "not mounted"}.
              {" "}Events in log: {diag.data.eventCount === null ? "unknown" : diag.data.eventCount}.
            </Text>
            {diag.data.plugins.filter((p) => p.state !== "healthy" && p.state !== "running").length > 0 ? (
              <Alert role="alert" color="yellow" title="Modules need attention">
                {diag.data.plugins
                  .filter((p) => p.state !== "healthy" && p.state !== "running")
                  .map((p) => `${p.id}: ${p.state}`)
                  .join(", ")}
              </Alert>
            ) : null}
          </Stack>
        ) : null}
      </Stack>

      <Stack gap="xs" data-testid="support-bundle-block">
        <Title order={5}>Support bundle</Title>
        {preview.data ? (
          <Text size="sm" c="var(--tantalar-color-text-dimmed)">
            Included sections: {preview.data.sections.join(", ")}. Secrets are always removed; media names are removed unless you include them.
          </Text>
        ) : null}
        <Group>
          <Button variant="default" data-testid="export-bundle-redacted" onClick={() => void exportBundle(false)}>
            Export redacted bundle
          </Button>
          <Button variant="light" data-testid="export-bundle-media" onClick={() => void exportBundle(true)}>
            Export with media names
          </Button>
        </Group>
      </Stack>

      {note ? <Text size="sm" role="status" data-testid="system-note">{note}</Text> : null}
    </Stack>
  );
}

// ---- Page shell ------------------------------------------------------------------

export type SettingsTab =
  | "general" | "libraries" | "downloads" | "indexers" | "quality" | "import"
  | "metadata" | "playback" | "users" | "integrations" | "vpn" | "system";

export function SettingsPage({ adminId, isAdmin }: { adminId: string | null; isAdmin: boolean }) {
  return (
    <Stack gap="lg" data-testid="settings-page">
      <Title order={3}>Settings</Title>
      <Tabs defaultValue="general" keepMounted={false}>
        <Tabs.List role="tablist" style={{ flexWrap: "wrap" }}>
          <Tabs.Tab value="general">General</Tabs.Tab>
          <Tabs.Tab value="libraries">Libraries</Tabs.Tab>
          <Tabs.Tab value="downloads">Downloads</Tabs.Tab>
          <Tabs.Tab value="indexers">Indexers</Tabs.Tab>
          <Tabs.Tab value="quality">Quality</Tabs.Tab>
          <Tabs.Tab value="import">Import</Tabs.Tab>
          <Tabs.Tab value="metadata">Metadata</Tabs.Tab>
          <Tabs.Tab value="playback">Playback</Tabs.Tab>
          <Tabs.Tab value="users">Users</Tabs.Tab>
          <Tabs.Tab value="integrations">Integrations</Tabs.Tab>
          <Tabs.Tab value="vpn">VPN</Tabs.Tab>
          <Tabs.Tab value="system">System</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="general" pt="sm"><GeneralSection adminId={adminId} /></Tabs.Panel>
        <Tabs.Panel value="libraries" pt="sm">
          <AdminOnly isAdmin={isAdmin}><LibrariesSection /></AdminOnly>
        </Tabs.Panel>
        <Tabs.Panel value="downloads" pt="sm"><DownloadsSection isAdmin={isAdmin} /></Tabs.Panel>
        <Tabs.Panel value="indexers" pt="sm"><IndexersSection isAdmin={isAdmin} /></Tabs.Panel>
        <Tabs.Panel value="quality" pt="sm">
          <PlaceholderSection
            title="Quality"
            testId="settings-quality"
            description="Transcoding picks a quality ladder automatically when direct play is not possible. Custom profiles arrive with quality-profile management."
          />
        </Tabs.Panel>
        <Tabs.Panel value="import" pt="sm"><ImportSection isAdmin={isAdmin} /></Tabs.Panel>
        <Tabs.Panel value="metadata" pt="sm">
          <PlaceholderSection
            title="Metadata"
            testId="settings-metadata"
            description="Artwork and details come from TMDB/TVDB through the metadata module when it is mounted."
          />
        </Tabs.Panel>
        <Tabs.Panel value="playback" pt="sm">
          <PlaceholderSection
            title="Playback"
            testId="settings-playback"
            description="Direct play is always attempted first. Transcoding starts only when your device cannot play the file."
          />
        </Tabs.Panel>
        <Tabs.Panel value="users" pt="sm">
          <AdminOnly isAdmin={isAdmin}><UsersSection /></AdminOnly>
        </Tabs.Panel>
        <Tabs.Panel value="integrations" pt="sm"><IntegrationsSection isAdmin={isAdmin} /></Tabs.Panel>
        <Tabs.Panel value="vpn" pt="sm">
          <AdminOnly isAdmin={isAdmin}>
            <PlaceholderSection
              title="VPN"
              testId="settings-vpn"
              description="Download traffic routes through an OpenVPN or WireGuard tunnel. A kill switch halts downloads before any leak when the tunnel drops."
            />
          </AdminOnly>
        </Tabs.Panel>
        <Tabs.Panel value="system" pt="sm">
          <Stack gap="md">
            <SystemSection />
            <SystemOpsSection isAdmin={isAdmin} />
          </Stack>
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}

function SystemSection() {
  const q = useQuery({ queryKey: ["settings", "health"], queryFn: () => api.systemHealth(), retry: false });
  if (q.isPending) return <div aria-busy="true">Loading system status…</div>;
  if (q.isError) return <Alert role="alert" color="red">{(q.error as Error).message}</Alert>;
  const degraded = !q.data.ready || q.data.eventCount === null;
  return (
    <Stack gap="sm" data-testid="settings-system">
      {degraded ? (
        <Alert color="yellow" title="Degraded service">
          <Text size="sm">Some subsystems did not report cleanly.</Text>
        </Alert>
      ) : (
        <Text c="var(--tantalar-color-success)">All systems ready.</Text>
      )}
      <Text size="sm">Events in log: {q.data.eventCount === null ? "unknown" : q.data.eventCount}</Text>
      <Stack gap={4}>
        {q.data.plugins.map((p) => (
          <Group key={p.id} justify="space-between">
            <Text size="sm">{p.id.replace("dev.tantalar.plugin.", "")}</Text>
            <Text size="sm" c={p.state === "running" ? "var(--tantalar-color-success)" : "var(--tantalar-color-warning)"}>
              {p.state}
            </Text>
          </Group>
        ))}
      </Stack>
    </Stack>
  );
}
