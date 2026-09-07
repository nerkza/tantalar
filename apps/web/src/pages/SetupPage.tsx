/** Resumable first-run setup backed by Tantalar's durable onboarding state. */
import { BrandLogo } from "../components/BrandLogo";
import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Button,
  Center,
  Group,
  Paper,
  PasswordInput,
  Progress,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { api, type DiagnosticsReport, type LibraryRecord } from "../api";
import { LibraryManager } from "../components/LibraryManager";

const STEP_LABELS: Record<string, string> = {
  administrator: "Administrator account",
  storage: "Storage and libraries",
  libraries: "Storage and libraries",
  "download-engines": "Download engines",
  indexers: "Indexers",
  metadata: "Metadata providers",
  "vpn-policy": "VPN policy",
  "final-health": "System check",
};

const STEP_IDS = [
  "administrator",
  "storage",
  "libraries",
  "download-engines",
  "indexers",
  "metadata",
  "vpn-policy",
  "final-health",
] as const;

const OPTIONAL_DETAILS: Record<string, string> = {
  "download-engines": "Torrent and Usenet engines are configured in Tantalar Control. This setup cannot verify an engine yet.",
  indexers: "Indexer management belongs in Tantalar Control. This setup cannot verify an indexer yet.",
  metadata: "Metadata providers are managed by installed modules. This setup cannot configure their credentials yet.",
  "vpn-policy": "VPN routing is configured in Tantalar Control. This setup cannot verify a tunnel yet.",
};

interface OnboardingState {
  steps: Record<string, { status: "pending" | "done" | "skipped" }>;
  complete: boolean;
}

export function SetupPage({
  onFinished,
  bootstrapRequired = true,
}: {
  onFinished: () => void;
  bootstrapRequired?: boolean;
}) {
  const [bootstrapped, setBootstrapped] = useState(!bootstrapRequired);
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(!bootstrapRequired);
  const [state, setState] = useState<OnboardingState | null>(null);
  const [health, setHealth] = useState<DiagnosticsReport | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      let next = await api.onboarding();
      if (next.steps.administrator?.status === "pending") {
        next = await api.onboardStep("administrator", "complete");
      }
      setState(next);
    } catch (cause) {
      setError(`Could not load setup: ${(cause as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (bootstrapped) void refresh();
  }, [bootstrapped, refresh]);

  useEffect(() => {
    if (state?.complete) onFinished();
  }, [onFinished, state?.complete]);

  const current = STEP_IDS.find((id) => state?.steps[id]?.status === "pending");

  const checkHealth = useCallback(async () => {
    setHealth(null);
    setHealthError(null);
    try {
      setHealth(await api.diagnostics());
    } catch (cause) {
      setHealthError((cause as Error).message);
    }
  }, []);

  useEffect(() => {
    if (current === "final-health") void checkHealth();
  }, [checkHealth, current]);

  const bootstrap = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.bootstrapAdmin(username.trim(), password);
      await api.login(username.trim(), password);
      setBootstrapped(true);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const updateStep = async (stepId: string, action: "complete" | "skip") => {
    setBusy(true);
    setError(null);
    try {
      setState(await api.onboardStep(stepId, action));
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const useLibraries = async (_libraries: ReadonlyArray<LibraryRecord>) => {
    setBusy(true);
    setError(null);
    try {
      let next = state;
      if (next?.steps.storage?.status === "pending") next = await api.onboardStep("storage", "complete");
      if (next?.steps.libraries?.status === "pending") next = await api.onboardStep("libraries", "complete");
      setState(next);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!bootstrapped) {
    return (
      <Center mih="100vh" p="md">
        <Paper shadow="sm" radius="md" p="xl" w={440} maw="100%">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void bootstrap();
            }}
          >
            <Stack gap="md">
              <BrandLogo />
              <div>
                <Title order={2}>Create your administrator</Title>
                <Text size="sm" c="dimmed" mt={4}>
                  This account controls libraries, downloads, networking, plugins, and other server settings.
                </Text>
              </div>
              <TextInput
                label="Username"
                name="username"
                autoComplete="username"
                required
                value={username}
                onChange={(event) => setUsername(event.currentTarget.value)}
              />
              <PasswordInput
                label="Password"
                name="password"
                data-testid="setup-password"
                description="Use at least 8 characters."
                autoComplete="new-password"
                minLength={8}
                required
                value={password}
                onChange={(event) => setPassword(event.currentTarget.value)}
              />
              {error ? <Alert color="red" role="alert">{error}</Alert> : null}
              <Button type="submit" loading={busy} data-testid="setup-create-admin">
                Create administrator
              </Button>
            </Stack>
          </form>
        </Paper>
      </Center>
    );
  }

  const completed = state ? STEP_IDS.filter((id) => state.steps[id]?.status !== "pending").length : 0;
  const progress = Math.round((completed / STEP_IDS.length) * 100);

  return (
    <Center mih="100vh" p="md" style={{ alignItems: "flex-start" }}>
      <Paper shadow="sm" radius="md" p="xl" w={760} maw="100%" mt="xl">
        <Stack gap="lg">
          <BrandLogo />
          <div>
            <Group justify="space-between" mb="xs">
              <div>
                <Title order={2}>{current ? STEP_LABELS[current] : "Setup complete"}</Title>
              </div>
              <Text size="sm" c="dimmed">{completed} of {STEP_IDS.length}</Text>
            </Group>
            <Progress value={progress} aria-label={`${progress}% of setup complete`} />
            <Text size="sm" c="dimmed" mt="xs">Progress is saved on the server. You can safely return later.</Text>
          </div>

          {loading ? <Text aria-busy="true">Loading setup…</Text> : null}

          {!loading && (current === "storage" || current === "libraries") ? (
            <Stack gap="md" data-testid="setup-step-libraries">
              <Alert color="blue" title="Choose storage by adding a library" role="note">
                Tantalar does not have a separate global storage location. Each library uses its own verified server path.
              </Alert>
              <LibraryManager defaultFormOpen onConfigured={useLibraries} />
            </Stack>
          ) : null}

          {!loading && current && OPTIONAL_DETAILS[current] ? (
            <Stack gap="md" data-testid={`setup-step-${current}`}>
              <Alert color="yellow" title="Optional setup" role="note">
                {OPTIONAL_DETAILS[current]}
              </Alert>
              <Text size="sm">
                You can skip this now. Tantalar records it as skipped, not configured, and you can finish it later in Control.
              </Text>
              <Group justify="flex-end">
                <Button
                  variant="light"
                  disabled={busy}
                  onClick={() => void updateStep(current, "skip")}
                >
                  Skip for now
                </Button>
              </Group>
            </Stack>
          ) : null}

          {!loading && current === "final-health" ? (
            <Stack gap="md" data-testid="setup-step-final-health">
              <Text size="sm">Tantalar checked the running server rather than asking you to confirm a checklist.</Text>
              {healthError ? (
                <Alert color="red" role="alert" title="System check failed">
                  <Stack gap="xs">
                    <Text size="sm">{healthError}</Text>
                    <Button variant="light" onClick={() => void checkHealth()}>Run check again</Button>
                  </Stack>
                </Alert>
              ) : null}
              {!health && !healthError ? <Text aria-busy="true">Checking the server…</Text> : null}
              {health ? (
                <Stack gap="xs">
                  <Alert color={health.ready ? "green" : "yellow"} title={health.ready ? "Core services are ready" : "Setup has warnings"}>
                    {health.ready
                      ? "Tantalar's required capabilities reported ready."
                      : "You can enter Tantalar, but some capabilities still need attention in Control."}
                  </Alert>
                  <Group justify="space-between"><Text size="sm">FFmpeg playback tools</Text><Text component="span" className="tantalar-inline-state" data-tone={health.transcoder.ffmpegAvailable ? "success" : "warning"}>{health.transcoder.ffmpegAvailable ? "Available" : "Unavailable"}</Text></Group>
                  <Group justify="space-between"><Text size="sm">VPN capability</Text><Text component="span" className="tantalar-inline-state" data-tone={health.network.vpnCapabilityMounted ? "success" : "neutral"}>{health.network.vpnCapabilityMounted ? "Mounted" : "Not mounted"}</Text></Group>
                  {health.missingCapabilities.length > 0 ? (
                    <Text size="sm" c="dimmed">Missing capabilities: {health.missingCapabilities.join(", ")}</Text>
                  ) : null}
                  <Group justify="flex-end" mt="sm">
                    <Button disabled={busy} onClick={() => void updateStep("final-health", "complete")}>
                      {health.ready ? "Finish setup" : "Finish with warnings"}
                    </Button>
                  </Group>
                </Stack>
              ) : null}
            </Stack>
          ) : null}

          {error ? <Alert color="red" role="alert">{error}</Alert> : null}
        </Stack>
      </Paper>
    </Center>
  );
}
