/**
 * Wave 8 product Settings page. Sections: Appearance, Libraries, Downloads,
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
import { useEffect, useState } from "react";
import { ActionNotice, useActionFeedback } from "../components/ActionNotice";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Button,
  Checkbox,
  ColorPicker,
  Divider,
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
  UnstyledButton,
} from "@mantine/core";
import { IconSquareAndArrowUp, IconTrayAndArrowDown } from "symbols-react";
import {
  api,
  type ApiKeyRecord,
  type McpConfiguration,
  type McpConnectionTestResult,
  type McpStatus,
} from "../api";
import { formatShortDate } from "../date";
import { useTheme } from "../theme/engine";
import {
  SCHEME_LABELS,
  BUILT_IN_THEMES,
  DEFAULT_TOKENS,
  TOKEN_PREFIX,
  TOKEN_LABELS,
  readableTextOn,
  resolveThemeTokens,
  sanitizeTokenOverrides,
  type TokenMap,
} from "../theme/tokens";
import { DensityToggle } from "../admin/views";
import { LibraryManager } from "../components/LibraryManager";
import "./appearance.css";

function AdminOnly({ isAdmin, children }: { isAdmin: boolean; children: React.ReactNode }) {
  if (isAdmin) return <>{children}</>;
  return (
    <Alert role="note" title="Administrator access required" color="yellow">
      <Text size="sm">This section needs an administrator account.</Text>
    </Alert>
  );
}

// ---- Appearance ----------------------------------------------------------------

const BASIC_THEME_COLORS = [
  { key: "color-primary", label: "Accent", help: "Links, selected items and main actions" },
  { key: "color-text", label: "Text", help: "Headings, labels and body copy" },
  { key: "color-bg", label: "Background", help: "The page behind all content" },
  { key: "color-surface", label: "Surface", help: "Sidebar and standard panels" },
  { key: "color-surface-raised", label: "Raised surface", help: "Text boxes, secondary buttons and menus" },
] as const;

const COLOR_SWATCHES = ["#10121a", "#191c27", "#eef0f6", "#2864c7", "#4d8df6", "#2e7d43", "#b97a0a", "#d13438"];

function ThemePalettePreview({ tokens, active }: { tokens: TokenMap; active: boolean }) {
  return (
    <span className="tantalar-preset__mock" style={{ background: tokens["color-bg"] }} aria-hidden="true">
      <span className="tantalar-preset__mock-rail" style={{ background: tokens["color-surface"] }}>
        <span style={{ background: tokens["color-primary"] }} />
        <span style={{ background: tokens["color-text-dimmed"] }} />
        <span style={{ background: tokens["color-text-dimmed"] }} />
      </span>
      <span className="tantalar-preset__mock-page">
        <span className="tantalar-preset__mock-title" style={{ background: tokens["color-text"] }} />
        <span
          className="tantalar-preset__mock-card"
          style={{ background: tokens["color-surface-raised"], borderColor: tokens["color-border"] }}
        >
          <span style={{ background: tokens["color-text-dimmed"] }} />
          <span style={{ background: tokens["color-primary"] }} />
        </span>
      </span>
      {active ? (
        <span
          className="tantalar-preset__check"
          style={{ background: tokens["color-primary"], color: tokens["color-primary-contrast"] }}
        >
          <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2.5 6.5 5 9l4.5-5.5" />
          </svg>
        </span>
      ) : null}
    </span>
  );
}

export function AppearanceSettings({
  adminId,
  advancedOnly = false,
  showModePicker = true,
}: {
  adminId: string | null;
  advancedOnly?: boolean;
  showModePicker?: boolean;
}) {
  const theme = useTheme();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<ReadonlyArray<string>>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(advancedOnly);
  const [expandedColor, setExpandedColor] = useState<string | null>(null);
  const [importDragging, setImportDragging] = useState(false);

  const checkedValues = (next: Record<string, string>) => sanitizeTokenOverrides(
    Object.fromEntries(Object.entries(next).filter(([, value]) => value.trim() !== "")),
  );
  const draft = checkedValues(values);
  const effectiveTokens = resolveThemeTokens(theme.scheme, theme.saved, draft.ok ? draft.tokens : {});
  const previewStyle = Object.fromEntries(
    Object.entries(effectiveTokens).map(([key, value]) => [`${TOKEN_PREFIX}${key}`, value]),
  ) as React.CSSProperties;

  const previewValues = (next: Record<string, string>) => {
    setValues(next);
    setStatus(null);
    const check = checkedValues(next);
    if (!check.ok) {
      setErrors(check.errors);
      return;
    }
    setErrors([]);
  };

  const previewToken = (key: string, value: string) => {
    const next = { ...values, [`${TOKEN_PREFIX}${key}`]: value };
    if (key === "color-primary" && /^#[0-9a-f]{6}$/i.test(value)) {
      next[`${TOKEN_PREFIX}color-primary-contrast`] = readableTextOn(value);
    }
    previewValues(next);
  };

  const resetColor = (key: string) => {
    const defaults = resolveThemeTokens(theme.scheme);
    const next = { ...values, [`${TOKEN_PREFIX}${key}`]: defaults[key]! };
    if (key === "color-primary") {
      next[`${TOKEN_PREFIX}color-primary-contrast`] = defaults["color-primary-contrast"]!;
    }
    previewValues(next);
  };

  const saveTheme = async () => {
    setErrors([]);
    setStatus(null);
    const check = checkedValues(values);
    if (!check.ok) {
      setErrors(check.errors);
      return;
    }
    try {
      const themeName = name.trim() || `My theme ${theme.themes.length + 1}`;
      await theme.save(themeName, check.tokens);
      setStatus(`${themeName} saved and activated.`);
      setName("");
      setValues({});
      if (adminId) void qc.invalidateQueries({ queryKey: ["prefs"] });
    } catch (err) {
      setErrors([(err as Error).message]);
    }
  };

  const activateTheme = async (themeId: string, themeName: string) => {
    setErrors([]);
    setStatus(null);
    try {
      await theme.activate(themeId);
      setValues({});
      setName("");
      setStatus(`${themeName} activated.`);
    } catch (cause) {
      setErrors([(cause as Error).message]);
    }
  };

  const activateBuiltInTheme = async (preset: (typeof BUILT_IN_THEMES)[number]) => {
    setErrors([]);
    setStatus(null);
    try {
      await theme.activatePreset(preset.scheme, preset.tokens);
      setValues({});
      setName("");
      setExpandedColor(null);
      setStatus(`${preset.name} applied.`);
    } catch (cause) {
      setErrors([(cause as Error).message]);
    }
  };

  const exportAppearance = () => {
    const blob = new Blob(
      [JSON.stringify({ version: 1, name: name || "tantalar-appearance", tokens: effectiveTokens }, null, 2)],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "tantalar-appearance.json";
    link.click();
    URL.revokeObjectURL(url);
  };

  const importAppearance = async (file: File | null) => {
    if (!file) return;
    setErrors([]);
    setStatus(null);
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Select a Tantalar appearance JSON file.");
      const envelope = parsed as { name?: unknown; tokens?: unknown };
      const raw = envelope.tokens ?? parsed;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("The file does not contain appearance tokens.");
      const check = sanitizeTokenOverrides(raw as Record<string, string>);
      if (!check.ok) throw new Error(check.errors.join(" "));
      setValues(Object.fromEntries(Object.entries(check.tokens).map(([key, value]) => [`${TOKEN_PREFIX}${key}`, value])));
      if (typeof envelope.name === "string") setName(envelope.name);
      setStatus("Appearance imported into the preview. Save it to keep it.");
    } catch (cause) {
      setErrors([(cause as Error).message]);
    }
  };

  const currentColor = (key: string): string => {
    const candidate = values[`${TOKEN_PREFIX}${key}`]
      ?? effectiveTokens[key]
      ?? DEFAULT_TOKENS[key]
      ?? "#10121a";
    return /^#[0-9a-f]{6}$/i.test(candidate) ? candidate : (DEFAULT_TOKENS[key] ?? "#10121a");
  };

  const colorInputValue = (key: string): string => values[`${TOKEN_PREFIX}${key}`] ?? currentColor(key);

  const advancedEditor = (
    <Stack gap="sm" data-testid="appearance-advanced-editor" className="tantalar-advanced-editor">
      <div className="tantalar-advanced-editor__intro">
        <Text size="sm" fw={600}>Advanced appearance</Text>
        <Text size="sm" c="dimmed">
          Import or export a complete theme, or tune the remaining visual details. Changes stay in the preview until you save.
        </Text>
      </div>
      <div className="tantalar-theme-transfer-grid">
        <label
          className="tantalar-theme-transfer"
          data-dragging={importDragging || undefined}
          data-testid="import-theme-dropzone"
          onDragEnter={(event) => {
            event.preventDefault();
            setImportDragging(true);
          }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={() => setImportDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setImportDragging(false);
            void importAppearance(event.dataTransfer.files[0] ?? null);
          }}
        >
          <input
            type="file"
            accept="application/json,.json"
            aria-label="Import theme"
            onChange={(event) => {
              void importAppearance(event.currentTarget.files?.[0] ?? null);
              event.currentTarget.value = "";
            }}
          />
          <IconTrayAndArrowDown className="tantalar-theme-transfer__icon" fill="currentColor" aria-hidden="true" />
          <span className="tantalar-theme-transfer__copy">
            <Text component="span" size="sm" fw={600}>Import theme</Text>
            <Text component="span" size="xs" c="dimmed">Drop a JSON file here, or click to choose a file.</Text>
          </span>
        </label>
        <UnstyledButton
          className="tantalar-theme-transfer"
          aria-label="Export theme"
          onClick={exportAppearance}
        >
          <IconSquareAndArrowUp className="tantalar-theme-transfer__icon" fill="currentColor" aria-hidden="true" />
          <span className="tantalar-theme-transfer__copy">
            <Text component="span" size="sm" fw={600}>Export theme</Text>
            <Text component="span" size="xs" c="dimmed">Download the current preview as a JSON file.</Text>
          </span>
        </UnstyledButton>
      </div>
      {Object.keys(DEFAULT_TOKENS).filter((key) => !BASIC_THEME_COLORS.some((color) => color.key === key)).map((key) => (
        <TextInput
          key={key}
          aria-label={TOKEN_LABELS[key] ?? key}
          label={TOKEN_LABELS[key] ?? key}
          value={values[`${TOKEN_PREFIX}${key}`] ?? ""}
          placeholder={DEFAULT_TOKENS[key]}
          onChange={(e) => previewToken(key, e.currentTarget.value)}
        />
      ))}
    </Stack>
  );

  return (
    <div data-testid="settings-general" className="tantalar-appearance-settings">
      <header className="tantalar-appearance-header">
        <div className="tantalar-appearance-header__copy">
          <Title order={3}>Appearance</Title>
          <Text size="sm" c="dimmed">
            Changes stay in the preview. Save a theme to apply it to the interface.
          </Text>
        </div>
        <ActionNotice message={status} title="Appearance" severity="success" />
      </header>

      <div className="tantalar-appearance-layout">
        <div className="tantalar-appearance-main">
          <section className="tantalar-appearance-section tantalar-appearance-section--display" aria-labelledby="display-heading">
            <div className="tantalar-appearance-section__intro">
              <Title id="display-heading" order={4}>Display</Title>
              <Text size="sm" c="dimmed">The foundation the interface is built on.</Text>
            </div>
            <div className="tantalar-display-card">
              {showModePicker ? (
                <div className="tantalar-display-row">
                  <div className="tantalar-display-row__copy">
                    <Text component="span" size="sm" fw={600}>Colour mode</Text>
                    <Text component="span" size="xs" c="dimmed">Light or dark foundation</Text>
                  </div>
                  <NativeSelect
                    aria-label="Theme"
                    data-testid="scheme-select"
                    value={theme.scheme}
                    onChange={(e) => theme.setScheme(e.currentTarget.value === "light" ? "light" : "dark")}
                    data={[
                      { value: "dark", label: SCHEME_LABELS.dark },
                      { value: "light", label: SCHEME_LABELS.light },
                    ]}
                  />
                </div>
              ) : null}
              <div className="tantalar-display-row">
                <div className="tantalar-display-row__copy">
                  <Text component="span" size="sm" fw={600}>Data density</Text>
                  <Text component="span" size="xs" c="dimmed">Add breathing room to tables and grids</Text>
                </div>
                <DensityToggle adminId={adminId} />
              </div>
            </div>
          </section>

          <section className="tantalar-appearance-section tantalar-appearance-section--themes" aria-labelledby="preset-themes-heading">
            <div className="tantalar-appearance-section__intro">
              <Title id="preset-themes-heading" order={4}>Themes</Title>
              <Text size="sm" c="dimmed">Complete palettes. Applying one never changes your saved themes.</Text>
            </div>
            <div className="tantalar-preset-grid">
              {BUILT_IN_THEMES.map((preset) => {
                const active = theme.scheme === preset.scheme
                  && Object.keys(DEFAULT_TOKENS).every((key) => theme.saved?.[key] === preset.tokens[key]);
                return (
                  <UnstyledButton
                    className="tantalar-preset"
                    data-active={active || undefined}
                    aria-label={`Use ${preset.name} theme`}
                    aria-pressed={active}
                    title={preset.description}
                    key={preset.id}
                    onClick={() => void activateBuiltInTheme(preset)}
                  >
                    <ThemePalettePreview tokens={preset.tokens} active={active} />
                    <span className="tantalar-preset__meta">
                      <Text component="span" size="sm" fw={600} className="tantalar-preset__name">{preset.name}</Text>
                      <Text component="span" size="xs" c="dimmed">{SCHEME_LABELS[preset.scheme]}</Text>
                    </span>
                  </UnstyledButton>
                );
              })}
            </div>
          </section>

          <section className="tantalar-appearance-section tantalar-appearance-section--saved" aria-labelledby="saved-themes-heading">
            <div className="tantalar-appearance-section__intro">
              <Title id="saved-themes-heading" order={4}>Saved themes</Title>
              <Text size="sm" c="dimmed">Select a saved theme to apply it.</Text>
            </div>
            {theme.themes.length === 0 ? (
              <div className="tantalar-saved-empty">
                <Text size="sm" c="dimmed">No saved themes.</Text>
              </div>
            ) : (
              <div className="tantalar-preset-grid">
                {theme.themes.map((savedTheme) => {
                  const active = theme.activeThemeId === savedTheme.id;
                  const tokens = resolveThemeTokens(theme.scheme, null, savedTheme.tokens);
                  return (
                    <UnstyledButton
                      className="tantalar-preset"
                      data-active={active || undefined}
                      aria-label={`Use ${savedTheme.name} theme`}
                      aria-pressed={active}
                      key={savedTheme.id}
                      onClick={() => void activateTheme(savedTheme.id, savedTheme.name)}
                    >
                      <ThemePalettePreview tokens={tokens} active={active} />
                      <span className="tantalar-preset__meta">
                        <Text component="span" size="sm" fw={600} className="tantalar-preset__name">{savedTheme.name}</Text>
                        <Text component="span" size="xs" c="dimmed">{active ? "Active" : "Saved"}</Text>
                      </span>
                    </UnstyledButton>
                  );
                })}
              </div>
            )}
          </section>

          <section className="tantalar-appearance-section tantalar-appearance-section--colours" aria-labelledby="custom-colours-heading">
            <div className="tantalar-appearance-section__intro">
              <Title id="custom-colours-heading" order={4}>Custom colours</Title>
              <Text size="sm" c="dimmed">Adjust one colour at a time. Save the theme when the preview is ready.</Text>
            </div>

            <div className="tantalar-color-list">
              {BASIC_THEME_COLORS.map((color) => {
                const expanded = expandedColor === color.key;
                return (
                  <div className="tantalar-color-card" data-expanded={expanded || undefined} key={color.key}>
                    <UnstyledButton
                      className="tantalar-color-row"
                      aria-label={`Edit ${color.label}`}
                      aria-expanded={expanded}
                      aria-controls={`${color.key}-editor`}
                      onClick={() => setExpandedColor(expanded ? null : color.key)}
                    >
                      <span className="tantalar-color-row__swatch" style={{ background: currentColor(color.key) }} aria-hidden="true" />
                      <span className="tantalar-color-row__copy">
                        <Text component="span" size="sm" fw={600}>{color.label}</Text>
                        <Text component="span" size="xs" c="dimmed">{color.help}</Text>
                      </span>
                      <span className="tantalar-color-row__value">
                        <code>{currentColor(color.key).toUpperCase()}</code>
                        <svg
                          className="tantalar-color-row__chevron"
                          aria-hidden="true"
                          viewBox="0 0 12 12"
                          width="12"
                          height="12"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M2.5 4.5 6 8l3.5-3.5" />
                        </svg>
                      </span>
                    </UnstyledButton>
                    {expanded ? (
                      <div id={`${color.key}-editor`} className="tantalar-color-editor" data-testid={`${color.key}-editor`}>
                        <div className="tantalar-color-editor__picker">
                          <ColorPicker
                            data-testid={`${color.key}-picker`}
                            value={currentColor(color.key)}
                            format="hex"
                            fullWidth
                            swatches={COLOR_SWATCHES}
                            swatchesPerRow={8}
                            saturationLabel={`${color.label} saturation`}
                            hueLabel={`${color.label} hue`}
                            onChange={(value) => previewToken(color.key, value)}
                          />
                        </div>
                        <div className="tantalar-color-editor__controls">
                          <TextInput
                            label="Hex value"
                            aria-label={`${color.label} hex value`}
                            value={colorInputValue(color.key)}
                            error={/^#[0-9a-f]{6}$/i.test(colorInputValue(color.key)) ? undefined : "Use #RRGGBB."}
                            onChange={(event) => previewToken(color.key, event.currentTarget.value)}
                          />
                          <Button size="compact-sm" variant="default" onClick={() => resetColor(color.key)}>
                            Reset to {SCHEME_LABELS[theme.scheme]}
                          </Button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>

            <div className="tantalar-theme-savebar">
              <TextInput
                className="tantalar-theme-savebar__name"
                label="Theme name"
                value={name}
                onChange={(event) => setName(event.currentTarget.value)}
                placeholder={`My theme ${theme.themes.length + 1}`}
              />
              <div className="tantalar-theme-savebar__actions">
                <Button data-testid="save-theme" disabled={errors.length > 0} onClick={() => void saveTheme()}>Save theme</Button>
                <Button
                  variant="default"
                  data-testid="revert-theme"
                  onClick={() => {
                    theme.revert();
                    setValues({});
                    setErrors([]);
                    setStatus("Preview reverted.");
                  }}
                >
                  Revert changes
                </Button>
                {!advancedOnly ? (
                  <Button
                    variant="subtle"
                    data-testid="toggle-advanced-appearance"
                    aria-expanded={showAdvanced}
                    onClick={() => setShowAdvanced((current) => !current)}
                  >
                    {showAdvanced ? "Hide advanced" : "Advanced appearance"}
                  </Button>
                ) : null}
              </div>
            </div>

            {errors.length > 0 ? (
              <div role="alert" data-testid="theme-errors" className="tantalar-theme-errors">
                <Text fw={700} size="sm">Fix these colours before you save.</Text>
                {errors.map((error) => <Text key={error} size="sm">{error}</Text>)}
              </div>
            ) : null}
            {showAdvanced ? advancedEditor : null}
          </section>

        </div>

        <aside className="tantalar-appearance-aside">
          <section className="tantalar-theme-preview" role="region" aria-label="Tantalar preview" style={previewStyle}>
            <div className="tantalar-appearance-section__intro">
              <Title order={4}>Tantalar preview</Title>
              <Text size="sm" c="dimmed">Custom colours appear here before you save.</Text>
            </div>
            <div className="tantalar-preview-window">
              <div className="tantalar-preview-chrome" aria-hidden="true">
                <span className="tantalar-preview-chrome__dot" />
                <span className="tantalar-preview-chrome__dot" />
                <span className="tantalar-preview-chrome__dot" />
                <span className="tantalar-preview-chrome__address">tantalar.local</span>
              </div>
              <header className="tantalar-preview-header">
                <strong>Tantalar</strong>
                <span>Control</span>
              </header>
              <div className="tantalar-preview-body">
                <aside className="tantalar-preview-sidebar" aria-label="Preview sidebar">
                  <span className="is-active">Overview</span>
                  <span>Media</span>
                  <span>System</span>
                </aside>
                <main className="tantalar-preview-main">
                  <Text component="h4" fw={700}>Library health</Text>
                  <Text size="sm">Review colour, surface, and control changes here.</Text>
                  <button type="button" className="tantalar-preview-link">View library details</button>
                  <div className="tantalar-preview-panel">
                    <Text fw={700} size="sm">Movies</Text>
                    <Text size="xs" c="dimmed">1,284 files indexed</Text>
                    <input aria-label="Preview input" readOnly value="/media/movies" />
                    <Group gap="xs">
                      <Button size="compact-sm">Save changes</Button>
                      <Button size="compact-sm" variant="default">Cancel</Button>
                    </Group>
                  </div>
                  <div className="tantalar-preview-statuses" aria-label="Preview statuses">
                    <span data-tone="success">Healthy</span>
                    <span data-tone="warning">Attention</span>
                    <span data-tone="danger">Failed</span>
                  </div>
                </main>
              </div>
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}

// ---- Libraries -----------------------------------------------------------------

function LibrariesSection() {
  return (
    <Stack gap="md" data-testid="settings-libraries">
      <Text size="sm" c="var(--tantalar-color-text-dimmed)">
        Libraries connect server folders to Tantalar. Removing a definition never deletes media files.
      </Text>
      <LibraryManager />
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
  const [testNote, setTestNote, testNoteSeverity, testNoteRevision] = useActionFeedback();
  if (!isAdmin) return <AdminOnly isAdmin={false}>{null}</AdminOnly>;
  if (q.isPending) return <div aria-busy="true">Loading indexers…</div>;
  if (q.isError) return <Alert role="alert" color="red">{(q.error as Error).message}</Alert>;

  const test = async (id: string) => {
    setTestNote(null);
    try {
      const res = await api.testIndexer(id);
      setTestNote(res.ok ? `${id}: connection OK.` : `${id}: ${res.detail ?? "test failed"}.`, res.ok ? "success" : "error");
    } catch (err) {
      setTestNote(`${id}: ${(err as Error).message}`, "error");
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
      <ActionNotice message={testNote} title="Indexer test" severity={testNoteSeverity} revision={testNoteRevision} />
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
  const [saveNote, setSaveNote, saveNoteSeverity, saveNoteRevision] = useActionFeedback();
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
      setSaveNote(`Not saved: ${(err as Error).message}`, "error");
    }
  };

  const runPlan = async (scheme: string) => {
    try {
      setPlan(await api.renamePlan(scheme));
    } catch (err) {
      setPlan(null);
      setSaveNote(`Rename plan failed: ${(err as Error).message}`, "error");
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
          <ActionNotice message={previewError} title="Naming preview failed" severity="error" />
          <ActionNotice message={saveNote} title="Naming scheme" severity={saveNoteSeverity} revision={saveNoteRevision} />
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
  const [note, setNote, noteSeverity, noteRevision] = useActionFeedback();

  const create = async () => {
    setNote(null);
    try {
      await api.createUser(username.trim(), password, role);
      setNote(`Created ${role} “${username.trim()}”.`);
      setUsername("");
      setPassword("");
      void qc.invalidateQueries({ queryKey: ["settings", "users"] });
    } catch (err) {
      setNote((err as Error).message, "error");
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
      <ActionNotice message={note} title="Users" severity={noteSeverity} revision={noteRevision} />
    </Stack>
  );
}

// ---- Integrations (Wave 9, TAN-033): API keys, webhooks, MCP ------------------

const KNOWN_KEY_SCOPES = [
  "events.read",
  "operations.read",
  "config.read",
  "plugins.read",
  "plugins.invoke",
  "queue.read",
  "queue.write",
] as const;
const MCP_READ_SCOPES = ["events.read", "operations.read", "config.read"] as const;
const MCP_TEST_METHODS = ["initialize", "ping", "tools/list"] as const;

function ApiKeyRows({
  keys,
  onRevoke,
}: {
  readonly keys: readonly ApiKeyRecord[];
  readonly onRevoke: (id: string) => void;
}) {
  if (keys.length === 0) return <Text size="sm" c="dimmed">No API keys.</Text>;
  return keys.map((key) => (
    <Group key={key.id} justify="space-between" wrap="wrap">
      <Text size="sm">
        {key.name} · {key.scopes.join(", ") || "no scopes"}
        {key.revokedAt ? " · revoked" : key.expiresAt ? ` · expires ${formatShortDate(key.expiresAt)}` : ""}
      </Text>
      {!key.revokedAt ? (
        <Button
          size="compact-xs"
          variant="light"
          color="red"
          data-testid={`revoke-key-${key.name}`}
          onClick={() => onRevoke(key.id)}
        >
          Revoke
        </Button>
      ) : null}
    </Group>
  ));
}

function SecretOnce({
  secret,
  onCopied,
  onCopyError,
  onDone,
}: {
  readonly secret: string;
  readonly onCopied: () => void;
  readonly onCopyError: (error: Error) => void;
  readonly onDone: () => void;
}) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(secret);
      onCopied();
    } catch (error) {
      onCopyError(error as Error);
    }
  };
  return (
    <Alert role="alert" title="Copy this key now — it will not be shown again" color="yellow" data-testid="apikey-secret-once">
      <Text size="sm" ff="monospace" style={{ wordBreak: "break-all" }}>{secret}</Text>
      <Group gap="xs" mt="xs">
        <Button size="compact-xs" variant="default" onClick={() => void copy()}>Copy key</Button>
        <Button size="compact-xs" variant="default" onClick={onDone}>Done</Button>
      </Group>
    </Alert>
  );
}

export function IntegrationsSection({
  isAdmin,
  onOpenMcp,
}: {
  readonly isAdmin: boolean;
  readonly onOpenMcp?: () => void;
}) {
  const qc = useQueryClient();
  const keys = useQuery({ queryKey: ["settings", "api-keys"], queryFn: () => api.apiKeys(), retry: false, enabled: isAdmin });
  const hooks = useQuery({ queryKey: ["settings", "webhooks"], queryFn: () => api.webhooks(), retry: false, enabled: isAdmin });
  const mcp = useQuery({ queryKey: ["settings", "mcp"], queryFn: () => api.mcpStatus(), retry: false, enabled: isAdmin });
  const [keyName, setKeyName] = useState("");
  const [keyExpiry, setKeyExpiry] = useState("");
  const [scopes, setScopes] = useState<readonly string[]>(["events.read"]);
  const [secretOnce, setSecretOnce] = useState<string | null>(null);
  const [hookUrl, setHookUrl] = useState("");
  const [hookEnvVar, setHookEnvVar] = useState("");
  const [note, setNote, noteSeverity, noteRevision] = useActionFeedback();

  if (!isAdmin) return <AdminOnly isAdmin={false}>{null}</AdminOnly>;

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
      setNote((err as Error).message, "error");
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
      setNote((err as Error).message, "error");
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
        {keys.data ? (
          <ApiKeyRows
            keys={keys.data.keys}
            onRevoke={(id) => void api.revokeApiKey(id).then(() => qc.invalidateQueries({ queryKey: ["settings", "api-keys"] }))}
          />
        ) : null}
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
          <SecretOnce
            secret={secretOnce}
            onCopied={() => setNote("API key copied.")}
                onCopyError={(error) => setNote(`Could not copy the API key: ${error.message}`, "error")}
            onDone={() => setSecretOnce(null)}
          />
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
                    .then((r) => setNote(r.ok ? `Test delivery succeeded (status ${r.status}).` : `Test delivery failed: ${r.detail ?? r.code ?? `status ${r.status}`}`, r.ok ? "success" : "error"))
                      .catch((err) => setNote(`Test delivery failed: ${(err as Error).message}`, "error"))
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

      {mcp.isPending ? <div aria-busy="true">Loading MCP status…</div> : null}
      {mcp.isError ? <Alert role="alert" color="red">{(mcp.error as Error).message}</Alert> : null}
      {mcp.data ? <McpSummary mcp={mcp.data} onOpen={onOpenMcp} /> : null}
      <ActionNotice message={note} title="Integrations" severity={noteSeverity} revision={noteRevision} />
    </Stack>
  );
}

function McpSummary({ mcp, onOpen }: { readonly mcp: McpStatus; readonly onOpen?: () => void }) {
  return (
    <Stack gap={4} data-testid="mcp-status">
      <Title order={5}>Model Context Protocol (MCP)</Title>
      <Text size="sm">
        {mcp.mounted
          ? `Mounted and ${mcp.state}. Version ${mcp.version ?? "?"}; audited calls: ${mcp.auditedCalls ?? "unknown"}.`
          : "The MCP module is not mounted."}
      </Text>
      <Text size="xs" c="var(--tantalar-color-text-dimmed)">Default policy: {mcp.defaultPolicy}.</Text>
      {onOpen ? <Button variant="default" w="fit-content" onClick={onOpen}>Open MCP setup</Button> : null}
    </Stack>
  );
}

function isLoopbackBind(bind: string): boolean {
  return bind === "127.0.0.1" || bind === "localhost" || bind === "::1";
}

function genericMcpClientConfig(status: McpStatus): string {
  return JSON.stringify({
    mcpServers: {
      tantalar: {
        transport: "streamable-http",
        url: status.endpoint ?? "http://127.0.0.1:8642/",
        headers: { "x-tantalar-key": "<TANTALAR_API_KEY>" },
      },
    },
  }, null, 2);
}

const MCP_TEST_FAILURE_COPY: Readonly<Record<string, string>> = {
  authentication: "The server rejected the API key. Enter a valid client key, then run the test again.",
  missing_scope: "The API key lacks a required scope. Create a key with the listed read scopes, then run the test again.",
  module_absent: "The MCP module is not mounted. Restore or enable the module, then run the test again.",
  plugin_failure: "The MCP module failed during the protocol check. Open MCP Audit, correct the module failure, then run the test again.",
  protocol: "The endpoint returned an invalid MCP response. Check the endpoint and reverse proxy, then run the test again.",
  transport: "The endpoint did not accept the transport request. Check the endpoint and reverse proxy, then run the test again.",
  transport_disabled: "Streamable HTTP is disabled. Enable it, apply the configuration, then run the test again.",
};

const MCP_CONFIG_RECOVERY_COPY: Readonly<Record<string, string>> = {
  module_absent: "Restore or enable the MCP module, then apply the configuration again.",
  port_conflict: "Choose an unused port, then apply the configuration again.",
  restart_failed: "Open MCP Audit, correct the configuration, then apply the last working settings again.",
  unsafe_bind: "Use a loopback bind, or configure trusted reverse-proxy TLS and an HTTPS client endpoint.",
};

type McpConfigError = Error & {
  readonly code?: string;
  readonly rolledBack?: boolean;
};

function mcpConfigErrorMessage(error: McpConfigError): string {
  const rollback = error.rolledBack === true
    ? "The last working configuration is active."
    : error.rolledBack === false
      ? "Automatic recovery did not complete."
      : null;
  const recovery = MCP_CONFIG_RECOVERY_COPY[error.code ?? ""];
  return [error.message, rollback, recovery].filter(Boolean).join(" ");
}

export function McpSettings({ onOpenAudit }: { readonly onOpenAudit: () => void }) {
  const status = useQuery({ queryKey: ["settings", "mcp"], queryFn: () => api.mcpStatus(), retry: false });
  if (status.isPending) return <div aria-busy="true">Loading MCP setup…</div>;
  if (status.isError) return <Alert role="alert" color="red">{(status.error as Error).message}</Alert>;
  return <McpSetup status={status.data} onOpenAudit={onOpenAudit} />;
}

function McpSetup({ status, onOpenAudit }: { readonly status: McpStatus; readonly onOpenAudit: () => void }) {
  const qc = useQueryClient();
  const keys = useQuery({ queryKey: ["settings", "api-keys"], queryFn: () => api.apiKeys(), retry: false });
  const [configuration, setConfiguration] = useState<McpConfiguration>(() => status.configuration);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [note, setNote, noteSeverity, noteRevision] = useActionFeedback();
  const [configFailure, setConfigFailure] = useState<string | null>(null);
  const [keyName, setKeyName] = useState("MCP client");
  const [keyExpiry, setKeyExpiry] = useState("");
  const [keyScopes, setKeyScopes] = useState<string[]>([...MCP_READ_SCOPES]);
  const [secretOnce, setSecretOnce] = useState<string | null>(null);
  const [testKey, setTestKey] = useState("");
  const [testResult, setTestResult] = useState<McpConnectionTestResult | null>(null);
  useEffect(() => setConfiguration(status.configuration), [status.configuration]);
  const clientConfig = genericMcpClientConfig(status);
  const loopback = isLoopbackBind(configuration.http.bind.trim());
  const remoteSafe = loopback || (
    configuration.http.tlsViaProxy
    && configuration.http.clientEndpoint?.trim().startsWith("https://") === true
  );

  const save = async () => {
    setSaving(true);
    setNote(null);
    setConfigFailure(null);
    try {
      const result = await api.updateMcpConfig(configuration);
      qc.setQueryData(["settings", "mcp"], result.status);
      setConfiguration(result.status.configuration);
      setNote("MCP configuration applied. The module restarted and reported its current state.");
    } catch (error) {
      setConfigFailure(mcpConfigErrorMessage(error as McpConfigError));
    } finally {
      setSaving(false);
    }
  };

  const createMcpKey = async () => {
    setNote(null);
    try {
      const result = await api.createApiKey(
        keyName.trim(),
        keyScopes,
        keyExpiry ? new Date(`${keyExpiry}T00:00:00.000Z`).toISOString() : null,
      );
      setSecretOnce(result.secret);
      setTestKey(result.secret);
      void qc.invalidateQueries({ queryKey: ["settings", "api-keys"] });
    } catch (error) {
      setNote((error as Error).message, "error");
    }
  };

  const testConnection = async () => {
    setTesting(true);
    setNote(null);
    setTestResult(null);
    try {
      setTestResult(await api.testMcpConnection(testKey));
    } catch (error) {
      setNote((error as Error).message, "error");
    } finally {
      setTesting(false);
    }
  };

  const copyClientConfig = async () => {
    try {
      await navigator.clipboard.writeText(clientConfig);
      setNote("Generic MCP client configuration copied.");
    } catch (error) {
      setNote(`Could not copy the client configuration: ${(error as Error).message}`, "error");
    }
  };

  return (
    <Stack gap="lg" data-testid="mcp-settings">
      <section aria-labelledby="mcp-status-heading">
        <Group justify="space-between" align="flex-start" wrap="wrap">
          <div>
            <Title order={2} id="mcp-status-heading">MCP setup</Title>
            <Text size="sm" c="dimmed">Configure the existing MCP module and verify its live endpoint.</Text>
          </div>
          <Group gap="xs">
            <Button variant="default" onClick={() => void qc.invalidateQueries({ queryKey: ["settings", "mcp"] })}>Refresh</Button>
            <Button variant="default" onClick={onOpenAudit}>Open MCP Audit</Button>
          </Group>
        </Group>
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} mt="md">
          <div><Text size="xs" c="dimmed">Module</Text><Text size="sm">{status.mounted ? "Mounted" : "Not mounted"}</Text></div>
          <div><Text size="xs" c="dimmed">Health</Text><Text size="sm">{status.healthy ? "Healthy" : status.state ?? "Unavailable"}</Text></div>
          <div><Text size="xs" c="dimmed">Version</Text><Text size="sm">{status.version ?? "Unknown"}</Text></div>
          <div><Text size="xs" c="dimmed">Transport</Text><Text size="sm">{status.activeTransport ?? "Disabled"}</Text></div>
          <div><Text size="xs" c="dimmed">Endpoint</Text><Text size="sm" ff="monospace">{status.endpoint ?? "Not available"}</Text></div>
          <div><Text size="xs" c="dimmed">Audited calls</Text><Text size="sm">{status.auditedCalls ?? "Unknown"}</Text></div>
          <div><Text size="xs" c="dimmed">Mutation gate</Text><Text size="sm">{status.mutatingToolsEnabled ? "Enabled" : "Disabled"}</Text></div>
          <div><Text size="xs" c="dimmed">Timeout</Text><Text size="sm">{status.limits.timeoutMs.toLocaleString()} ms</Text></div>
          <div><Text size="xs" c="dimmed">Result limit</Text><Text size="sm">{status.limits.maxResultBytes.toLocaleString()} bytes</Text></div>
          <div><Text size="xs" c="dimmed">Rate limit</Text><Text size="sm">{status.limits.rateLimitPerMinute.toLocaleString()} requests/minute</Text></div>
        </SimpleGrid>
        {status.recovery ? (
          <Alert color="yellow" title="Recovery required" mt="md">
            <Text size="sm">{status.recovery.action}</Text>
          </Alert>
        ) : null}
        {status.configError ? <Alert color="red" role="alert" mt="md">{status.configError}</Alert> : null}
      </section>

      <Divider />

      <section aria-labelledby="mcp-http-heading">
        <Title order={3} id="mcp-http-heading">1. Configure Streamable HTTP</Title>
        <Text size="sm" c="dimmed" mb="sm">Loopback and read-only tools are the safe defaults.</Text>
        <Stack gap="sm" maw={720}>
          <Switch
            label="Enable Streamable HTTP"
            checked={configuration.http.enabled}
            onChange={(event) => setConfiguration((current) => ({
              ...current,
              http: { ...current.http, enabled: event.currentTarget.checked },
            }))}
          />
          <NumberInput
            label="Port"
            min={1024}
            max={65_535}
            value={configuration.http.port}
            onChange={(value) => setConfiguration((current) => ({
              ...current,
              http: { ...current.http, port: Number(value) },
            }))}
          />
          <details>
            <summary>Advanced settings</summary>
            <Stack gap="sm" mt="sm">
              <TextInput
                label="Bind address"
                value={configuration.http.bind}
                onChange={(event) => setConfiguration((current) => ({
                  ...current,
                  http: { ...current.http, bind: event.currentTarget.value },
                }))}
              />
              <Switch
                label="Traffic uses a trusted reverse proxy with TLS"
                checked={configuration.http.tlsViaProxy}
                onChange={(event) => setConfiguration((current) => ({
                  ...current,
                  http: { ...current.http, tlsViaProxy: event.currentTarget.checked },
                }))}
              />
              <TextInput
                label="Client endpoint"
                placeholder={loopback ? "Optional for loopback" : "https://tantalar.example/mcp"}
                value={configuration.http.clientEndpoint ?? ""}
                onChange={(event) => setConfiguration((current) => ({
                  ...current,
                  http: { ...current.http, clientEndpoint: event.currentTarget.value || undefined },
                }))}
              />
              {!loopback ? (
                <Alert color={remoteSafe ? "yellow" : "red"} role={remoteSafe ? "note" : "alert"}>
                  {remoteSafe
                    ? "Remote binding is configured. Save it, then verify the HTTPS endpoint below."
                    : "Remote binding requires trusted reverse-proxy TLS and an HTTPS client endpoint."}
                </Alert>
              ) : null}
              <SimpleGrid cols={{ base: 1, sm: 3 }}>
                <NumberInput
                  label="Timeout (ms)"
                  min={1_000}
                  max={120_000}
                  value={configuration.limits.timeoutMs}
                  onChange={(value) => setConfiguration((current) => ({
                    ...current,
                    limits: { ...current.limits, timeoutMs: Number(value) },
                  }))}
                />
                <NumberInput
                  label="Maximum result (bytes)"
                  min={4_096}
                  max={8_388_608}
                  value={configuration.limits.maxResultBytes}
                  onChange={(value) => setConfiguration((current) => ({
                    ...current,
                    limits: { ...current.limits, maxResultBytes: Number(value) },
                  }))}
                />
                <NumberInput
                  label="Requests per minute"
                  min={1}
                  max={10_000}
                  value={configuration.limits.rateLimitPerMinute}
                  onChange={(value) => setConfiguration((current) => ({
                    ...current,
                    limits: { ...current.limits, rateLimitPerMinute: Number(value) },
                  }))}
                />
              </SimpleGrid>
              <Switch
                label="Enable the global mutation gate"
                checked={configuration.mutatingToolsEnabled}
                onChange={(event) => setConfiguration((current) => ({
                  ...current,
                  mutatingToolsEnabled: event.currentTarget.checked,
                }))}
              />
              {configuration.mutatingToolsEnabled ? (
                <Alert color="yellow">
                  Operation-specific API-key scopes still apply. Forbidden administration tools remain unavailable.
                </Alert>
              ) : null}
            </Stack>
          </details>
          <Group gap="xs">
            <Button loading={saving} disabled={!remoteSafe} onClick={() => void save()}>Apply configuration</Button>
            <Button
              variant="default"
              disabled={saving}
              onClick={() => {
                setConfiguration(status.configuration);
                setConfigFailure(null);
              }}
            >
              Reset
            </Button>
          </Group>
        </Stack>
      </section>

      <Divider />

      <section aria-labelledby="mcp-key-heading">
        <Title order={3} id="mcp-key-heading">2. Create a client key</Title>
        <Text size="sm" c="dimmed" mb="sm">The default scopes permit the generic read tools only.</Text>
        <Stack gap="sm" maw={720}>
          {keys.isPending ? <div aria-busy="true">Loading keys…</div> : null}
          {keys.isError ? <Alert role="alert" color="red">{(keys.error as Error).message}</Alert> : null}
          {keys.data ? (
            <ApiKeyRows
              keys={keys.data.keys}
              onRevoke={(id) => void api.revokeApiKey(id).then(() => qc.invalidateQueries({ queryKey: ["settings", "api-keys"] }))}
            />
          ) : null}
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <TextInput label="Key name" value={keyName} onChange={(event) => setKeyName(event.currentTarget.value)} />
            <TextInput
              type="date"
              label="Expiry (optional)"
              value={keyExpiry}
              onChange={(event) => setKeyExpiry(event.currentTarget.value)}
            />
          </SimpleGrid>
          <Checkbox.Group label="Read scopes" value={keyScopes} onChange={setKeyScopes}>
            <Group mt="xs">
              {MCP_READ_SCOPES.map((scope) => <Checkbox key={scope} value={scope} label={scope} />)}
            </Group>
          </Checkbox.Group>
          <Button w="fit-content" disabled={!keyName.trim()} onClick={() => void createMcpKey()}>Create read-only key</Button>
          {secretOnce ? (
            <SecretOnce
              secret={secretOnce}
              onCopied={() => setNote("API key copied.")}
                  onCopyError={(error) => setNote(`Could not copy the API key: ${error.message}`, "error")}
              onDone={() => setSecretOnce(null)}
            />
          ) : null}
        </Stack>
      </section>

      <Divider />

      <section aria-labelledby="mcp-client-heading">
        <Title order={3} id="mcp-client-heading">3. Configure a client</Title>
        <Text size="sm" c="dimmed" mb="sm">This generic template uses the live endpoint and a secret placeholder.</Text>
        <Textarea
          aria-label="Generic MCP client configuration"
          value={clientConfig}
          readOnly
          autosize
          minRows={9}
          ff="monospace"
          maw={720}
        />
        <Button variant="default" mt="sm" onClick={() => void copyClientConfig()}>Copy client configuration</Button>
      </section>

      <Divider />

      <section aria-labelledby="mcp-test-heading">
        <Title order={3} id="mcp-test-heading">4. Test the connection</Title>
        <Text size="sm" c="dimmed" mb="sm">The server tests initialize, ping, and tools/list against the saved endpoint.</Text>
        <Stack gap="sm" maw={720}>
          <PasswordInput
            label="Client API key"
            value={testKey}
            onChange={(event) => setTestKey(event.currentTarget.value)}
            autoComplete="off"
          />
          <Group gap="xs">
            <Button loading={testing} disabled={!testKey} onClick={() => void testConnection()}>Run protocol test</Button>
            <Button variant="default" disabled={!testKey || testing} onClick={() => setTestKey("")}>Clear key</Button>
          </Group>
          {testResult ? (
            <Alert
              role={testResult.ok ? "status" : "alert"}
              color={testResult.ok ? "green" : "red"}
              title={testResult.ok ? "Protocol test passed" : "Protocol test failed"}
              data-testid="mcp-test-result"
            >
              {!testResult.ok ? (
                <Text size="sm">{MCP_TEST_FAILURE_COPY[testResult.code ?? ""] ?? "The MCP module did not complete the protocol test."}</Text>
              ) : null}
              <Stack component="ul" gap={2} mt="xs">
                {MCP_TEST_METHODS.map((method) => {
                  const passed = testResult.checks.some((check) => check.name === method && check.ok);
                  return <Text component="li" size="sm" key={method}>{method}: {passed ? "Passed" : "Not completed"}</Text>;
                })}
              </Stack>
            </Alert>
          ) : null}
        </Stack>
      </section>

      <Divider />

      <section aria-labelledby="mcp-tools-heading">
        <Title order={3} id="mcp-tools-heading">Available tools</Title>
        {status.tools.length === 0 ? <Text size="sm" c="dimmed">No tools reported by the module.</Text> : (
          <Stack gap="xs" mt="sm">
            {status.tools.map((tool) => (
              <Paper key={tool.name} p="sm" withBorder>
                <Group justify="space-between" align="flex-start" wrap="wrap">
                  <div>
                    <Text fw={600}>{tool.name}</Text>
                    <Text size="sm">{tool.purpose}</Text>
                  </div>
                  <Text size="sm">{tool.mutates ? "Mutation" : "Read"} · {tool.enabled ? "Enabled" : "Disabled"}</Text>
                </Group>
                <Text size="xs" c="dimmed" mt={4}>Required scopes: {tool.requiredScopes.join(", ") || "valid key only"}</Text>
              </Paper>
            ))}
          </Stack>
        )}
      </section>

      <ActionNotice message={configFailure} title="MCP configuration failed" severity="error" />
      <ActionNotice message={note} title="MCP" severity={noteSeverity} revision={noteRevision} />
      <Text size="xs" c="dimmed">Client secrets remain in memory only and are never written into generated configuration.</Text>
    </Stack>
  );
}

// ---- System (Wave 9, TAN-042/043): backup/restore + diagnostics + bundle -------

function SystemOpsSection({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const diag = useQuery({ queryKey: ["settings", "diagnostics"], queryFn: () => api.diagnostics(), retry: false, enabled: isAdmin });
  const preview = useQuery({ queryKey: ["settings", "bundle-preview"], queryFn: () => api.supportBundlePreview(), retry: false, enabled: isAdmin });
  const [note, setNote, noteSeverity, noteRevision] = useActionFeedback();
  const [restorePath, setRestorePath] = useState("");

  if (!isAdmin) return <AdminOnly isAdmin={false}>{null}</AdminOnly>;

  const runBackup = async () => {
    setNote(null);
    try {
      const res = await api.backup();
      setNote(`Backup written to ${res.path}. Includes: ${res.includes.join(", ")}.`);
      void qc.invalidateQueries({ queryKey: ["settings", "diagnostics"] });
    } catch (err) {
      setNote((err as Error).message, "error");
    }
  };

  const runRestore = async () => {
    setNote(null);
    if (!window.confirm("Restore replaces the live database after validation. A safety backup of the current database is taken first. Continue?")) return;
    try {
      const res = await api.restore(restorePath.trim());
      setNote(res.note);
    } catch (err) {
      setNote(`Restore refused: ${(err as Error).message}`, "error");
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
      setNote((err as Error).message, "error");
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

      <ActionNotice message={note} title="System" severity={noteSeverity} revision={noteRevision} />
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
          <Tabs.Tab value="general">Appearance</Tabs.Tab>
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

        <Tabs.Panel value="general" pt="sm"><AppearanceSettings adminId={adminId} /></Tabs.Panel>
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
