/** Control-first setup. All saved drafts use the server's non-secret allowlist. */
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Group, NativeSelect, Paper, PasswordInput, Radio, Stack, Text, TextInput, Title } from "@mantine/core";
import { ONBOARDING_STEPS, type OnboardingState, type OnboardingStepId, type OnboardingPreferences } from "@tantalar/contracts";
import { api } from "../api";
import { BrandLogo } from "../components/BrandLogo";
import { ConfigurationImport } from "../components/ConfigurationBackup";
import { LibraryManager } from "../components/LibraryManager";
import { PictureEditor } from "../components/ProfilePicture";
import { AcquisitionControl, DiscoveryView, IndexersPanel, MetadataControl, ModuleSetupPanel } from "../shell/OperationsViews";
import { ReleaseSearchPage } from "../shell/ReleaseSearchPage";
import { PlayerPage } from "./PlayerPage";
import { stateLabel } from "../state-label";
import "./setup.css";

const LABELS: Record<OnboardingStepId, string> = {
  administrator: "Administrator account", experience: "Choose your frontend", libraries: "Libraries",
  acquisition: "Acquisition", metadata: "Metadata", "first-title": "First title", playback: "Playback", "final-health": "Review setup",
};
const STATUS = { pending: "Not checked", configured: "Configured", done: "Verified", skipped: "Skipped", failed: "Failed" };

export function SetupPage({ onFinished, onExit, bootstrapRequired = true }: {
  onFinished: (state: OnboardingState) => void;
  onExit?: (state: OnboardingState) => void;
  bootstrapRequired?: boolean;
}) {
  const [bootstrapped, setBootstrapped] = useState(!bootstrapRequired);
  const [importSetup, setImportSetup] = useState(false);
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<OnboardingState | null>(null);
  const [metadataQuery, setMetadataQuery] = useState("");
  const [titleView, setTitleView] = useState("local");
  const [waitExpired, setWaitExpired] = useState(false);
  const playbackReported = useRef(false);
  const current = state?.currentStep;
  const releaseTarget = state?.releaseTarget;
  const me = useQuery({ queryKey: ["setup", "me"], queryFn: api.me, enabled: bootstrapped, retry: false });
  const catalog = useQuery({ queryKey: ["setup", "catalog"], queryFn: () => api.catalog(),
    enabled: bootstrapped && current === "first-title", refetchInterval: current === "first-title" && !waitExpired ? 5000 : false, retry: false });
  const downloads = useQuery({ queryKey: ["setup", "download", state?.downloadJobId], queryFn: () => api.queue(true),
    enabled: current === "first-title" && !!state?.downloadJobId, refetchInterval: current === "first-title" && !waitExpired ? 5000 : false, retry: false });
  const selectedDownload = downloads.data?.jobs.find(job => job.jobId === state?.downloadJobId);
  const health = useQuery({ queryKey: ["setup", "health"], queryFn: () => api.diagnostics(), enabled: current === "final-health", retry: false });
  const backendReady = health.data && (health.data.ready || health.data.missingCapabilities.length > 0 && health.data.missingCapabilities.every(cap => cap === "dev.tantalar.capability.serving"));

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const next = await api.onboarding();
      setState(next);
      setMetadataQuery(next.metadataQuery);
    } catch (cause) { setError(`Could not load setup: ${(cause as Error).message}`); }
  }, []);
  useEffect(() => { if (bootstrapped) void refresh(); }, [bootstrapped, refresh]);
  useEffect(() => {
    if (current !== "first-title") return;
    setWaitExpired(false);
    const timer = window.setTimeout(() => setWaitExpired(true), 120_000);
    return () => window.clearTimeout(timer);
  }, [current]);
  useEffect(() => { playbackReported.current = false; }, [state?.titleFileId]);
  useEffect(() => { if (state?.downloadJobId) setTitleView("downloads"); else if (state?.releaseTarget) setTitleView("discover"); }, [state?.downloadJobId, state?.releaseTarget?.id]);

  const run = async (action: () => Promise<OnboardingState>) => {
    setBusy(true); setError(null);
    try { const next = await action(); setState(next); return next; }
    catch (cause) { setError((cause as Error).message); return undefined; }
    finally { setBusy(false); }
  };
  const save = (preferences: OnboardingPreferences) => run(() => api.onboardPreferences({ metadataQuery, ...preferences }));
  const step = (action: "complete" | "skip") => run(async () => {
    if (current === "metadata") await api.onboardPreferences({ metadataQuery });
    return api.onboardStep(current!, action);
  });
  const bootstrap = async () => {
    setBusy(true); setError(null);
    try {
      await api.bootstrapAdmin(username.trim(), password);
      await api.login(username.trim(), password);
      setPassword(""); setBootstrapped(true);
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };

  if (!bootstrapped) return <main className="tantalar-setup tantalar-setup--account">
    <Paper withBorder p="lg" radius="md">
      <form onSubmit={event => { event.preventDefault(); void bootstrap(); }}><Stack gap="md">
        <BrandLogo />
        <Title order={1}>Create your administrator</Title>
        <Text size="sm">{importSetup ? "Create a temporary administrator to authorise import. The imported file replaces this account at restart." : "Create an administrator, or import an existing configuration."}</Text>
        <TextInput label="Username" name="username" autoComplete="username" required value={username} onChange={event => setUsername(event.currentTarget.value)} />
        <PasswordInput label="Password" name="password" autoComplete="new-password" description="Use at least 8 characters." minLength={8} required value={password} onChange={event => setPassword(event.currentTarget.value)} data-testid="setup-password" />
        {error ? <Text role="alert" c="var(--tantalar-color-danger)">{error}</Text> : null}
        <Button type="submit" loading={busy} data-testid="setup-create-admin">Create administrator</Button>
        <Button type="button" variant="default" disabled={busy} onClick={() => setImportSetup(!importSetup)}>{importSetup ? "Set up without importing" : "Import a configuration file"}</Button>
      </Stack></form>
    </Paper>
  </main>;

  if (importSetup) return <main className="tantalar-setup tantalar-setup--account"><Paper withBorder p="lg" radius="md"><Stack gap="md">
    <BrandLogo /><Title order={1}>Restore Tantalar</Title><ConfigurationImport />
    <Button variant="default" onClick={() => setImportSetup(false)}>Return to setup</Button>
  </Stack></Paper></main>;

  if (!state) return <main className="tantalar-setup"><BrandLogo />{error ? <Stack><Text role="alert">{error}</Text><Button onClick={() => void refresh()}>Retry setup</Button></Stack> : <Text aria-busy="true">Loading setup…</Text>}</main>;
  const visibleSteps = ONBOARDING_STEPS.filter(id => state.mediaEnabled || id !== "playback");
  const index = visibleSteps.indexOf(state.currentStep);
  const currentState = state.steps[state.currentStep];
  const optional = !["administrator", "experience", "final-health"].includes(state.currentStep);
  const continueLabel = current === "libraries" ? "Verify library paths" : current === "acquisition" ? "Check acquisition" : current === "metadata" ? "Search and verify" : current === "first-title" ? "Verify selected title" : current === "playback" ? "Check playback" : "Continue";

  return <main className="tantalar-setup">
    <BrandLogo />
    <div className="tantalar-setup__layout">
      <nav aria-label="Setup progress"><ol className="tantalar-setup__steps">
        {visibleSteps.map(id => <li key={id}><button type="button" aria-current={current === id ? "step" : undefined} disabled={busy} onClick={() => void save({ currentStep: id })}>
          <span>{LABELS[id]}</span><span className="tantalar-metadata-tag">{id === "experience" && state.steps[id].status === "done" ? "Selected" : STATUS[state.steps[id].status]}</span>
        </button></li>)}
      </ol></nav>
      <Paper withBorder p={{ base: "sm", sm: "lg" }} radius="md" className="tantalar-setup__panel" data-step={current}>
        <Stack gap="lg">
          <Title order={1}>{LABELS[state.currentStep]}</Title>
          {current === "administrator" ? <Stack>
            {me.isPending ? <Text aria-busy="true">Loading account…</Text> : null}
            {me.isError ? <Text role="alert">Could not load the account. Reload setup to retry.</Text> : null}
            {me.data?.user ? <><Text>{me.data.user.username} · Administrator</Text><PictureEditor userId={me.data.user.id} username={me.data.user.username} avatar={me.data.user.avatar} onSaved={() => void me.refetch()} /></> : null}
            <ConfigurationImport />
          </Stack> : null}
          {current === "experience" ? <Radio.Group label="Frontend" value={state.mediaEnabled ? "media" : "control"} onChange={value => void save({ mediaEnabled: value === "media" })}>
            <Stack mt="sm">
              <Radio disabled={busy} value="control" label="Control only" description="Manage the backend. Use your preferred media frontend or player." />
              <Radio disabled={busy} value="media" label="Control and Tantalar Media" description="Also browse and play media in Tantalar." />
            </Stack>
          </Radio.Group> : null}
          {current === "libraries" ? <LibraryManager /> : null}
          {current === "acquisition" ? <Stack gap="lg">
            <NativeSelect label="Download engine" value={state.acquisitionMode} disabled={busy} onChange={event => void save({ acquisitionMode: event.currentTarget.value as OnboardingState["acquisitionMode"] })} data={[{ value: "none", label: "Leave acquisition for later" }, { value: "usenet", label: "Usenet" }, { value: "torrent", label: "Torrents" }]} />
            {state.acquisitionMode !== "none" ? <>
              <ModuleSetupPanel module={state.acquisitionMode} setupOnly />
              <Title order={2}>Indexers</Title><IndexersPanel />
              {state.acquisitionMode === "torrent" ? <details><summary>Advanced network and VPN</summary><ModuleSetupPanel module="vpn" setupOnly /></details> : null}
            </> : null}
          </Stack> : null}
          {current === "metadata" ? <Stack gap="lg"><MetadataControl /><TextInput label="Title to search" maxLength={120} value={metadataQuery} onChange={event => setMetadataQuery(event.currentTarget.value)} /></Stack> : null}
          {current === "first-title" ? <Stack gap="md">
            <NativeSelect label="Title source" value={titleView} onChange={event => setTitleView(event.currentTarget.value)} data={[{ value: "local", label: "Local catalog" }, ...(state.acquisitionMode !== "none" ? [{ value: "discover", label: "Find a title to acquire" }, { value: "downloads", label: "Download and import progress" }] : [])]} />
            {titleView === "discover" ? releaseTarget ? <><Button variant="default" onClick={() => void save({ releaseTarget: null, downloadJobId: null })}>Find another title</Button><ReleaseSearchPage target={releaseTarget} embedded onGrabbed={downloadJobId => void save({ downloadJobId })} /></> : <><Text size="sm">Setup adds titles without automatic monitoring. Choose a release explicitly to start a download.</Text><DiscoveryView interactiveOnly onOpenManagedReleases={target => void save({ releaseTarget: { kind: target.kind, id: target.id } })} /></> : null}
            {selectedDownload ? <Text role="status">Selected download: {selectedDownload.title} · {stateLabel(selectedDownload.status ?? selectedDownload.state)} · {selectedDownload.progressPercent}%</Text> : null}
            {titleView === "downloads" ? <AcquisitionControl adminId={me.data?.user?.id ?? null} activeSection="downloads" /> : null}
            {catalog.isPending ? <Text aria-busy="true">Loading catalog…</Text> : null}
            {catalog.isError ? <Text role="alert">Could not load the catalog. Retry below.</Text> : null}
            {catalog.data?.items.length === 0 ? <Text>No catalogued files. Scan a library, or wait for a download to import.</Text> : null}
            <NativeSelect label="Selected title" value={state.titleFileId ?? ""} disabled={busy} onChange={event => void save({ titleFileId: event.currentTarget.value || null })} data={[{ value: "", label: "Select a title" }, ...(catalog.data?.items ?? []).map(item => ({ value: item.fileId, label: item.title ?? item.path }))]} />
            <Button variant="default" onClick={() => void catalog.refetch()}>Refresh catalog</Button>
            {waitExpired ? <Text role="status">The two-minute check window ended. Check download progress, refresh the catalog, or save and exit. Downloads continue.</Text> : null}
          </Stack> : null}
          {current === "playback" ? state.mediaEnabled && state.titleFileId ? <>
            <PlayerPage fileId={state.titleFileId} onPlaybackProgress={(positionMs, durationMs) => {
              if (playbackReported.current) return;
              playbackReported.current = true;
              void api.setResume(state.titleFileId!, positionMs, durationMs).catch(() => { playbackReported.current = false; });
            }} />
            <Text size="sm">Start playback, then run the check. If it fails, retry or leave playback for later.</Text>
          </> : <Text>{state.mediaEnabled ? "Select a catalogued title in First title." : "Tantalar Media is disabled. Playback is optional."}</Text> : null}
          {current === "final-health" ? <Stack gap="sm">
            <Text>{state.mediaEnabled ? "Control and Tantalar Media" : "Control only"}</Text>
            {health.isPending ? <Text aria-busy="true">Checking the server…</Text> : null}
            {health.isError ? <Text role="alert">The server check failed. Retry before finishing setup.</Text> : null}
            {health.data ? <>
              <Text role="status">{backendReady ? "Backend capability check passed." : "Backend capabilities need attention in Control → System → Health."}</Text>
              {state.mediaEnabled ? <Text size="sm">Playback tools: {health.data.transcoder.ffmpegAvailable ? "Available" : "Unavailable — review Control → Playback."}</Text> : null}
            </> : null}
            <Button variant="default" onClick={() => void health.refetch()} loading={health.isFetching}>Run server check again</Button>
            {ONBOARDING_STEPS.filter(id => id !== "final-health").map(id => <div key={id} className="tantalar-setup__result">
              <Group justify="space-between"><Text fw={500}>{LABELS[id]}</Text><span className="tantalar-metadata-tag">{id === "experience" && state.steps[id].status === "done" ? "Selected" : STATUS[state.steps[id].status]}</span></Group>
              {state.steps[id].detail ? <Text size="sm" c="dimmed">{state.steps[id].detail}</Text> : null}
            </div>)}
            <Text size="sm">Skipped checks remain unverified. Control does not require a playable title.</Text>
          </Stack> : null}
          {currentState.detail && current !== "final-health" ? <Text role={currentState.status === "failed" ? "alert" : "status"}>{currentState.detail}</Text> : null}
          {error ? <Alert role="alert" title="Setup needs attention">{error}</Alert> : null}
          <Group justify="space-between" className="tantalar-setup__actions">
            <Button variant="default" disabled={busy || index <= 0} onClick={() => void save({ currentStep: visibleSteps[index - 1]! })}>Back</Button>
            <Group gap="xs">
              <Button variant="subtle" disabled={busy || !onExit} onClick={() => void save({ metadataQuery }).then(next => { if (next) onExit?.(next); })}>Save and exit</Button>
              {optional ? <Button variant="default" disabled={busy} onClick={() => void step("skip")}>Leave for later</Button> : null}
              {current === "final-health" ? <Button loading={busy} disabled={!health.data || health.isError || health.isFetching} onClick={() => void step("complete").then(next => { if (next?.complete) onFinished(next); })}>Finish setup</Button>
                : <Button loading={busy} onClick={() => void step("complete")}>{continueLabel}</Button>}
            </Group>
          </Group>
        </Stack>
      </Paper>
    </div>
  </main>;
}
