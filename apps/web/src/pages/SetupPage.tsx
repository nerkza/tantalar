/**
 * Guided setup (wave 2, TAN-003): first-run bootstrap of the one-time
 * administrator plus the durable onboarding wizard. Shown only while the
 * server has no users (bootstrap) or onboarding has pending steps; existing
 * installs go straight to sign-in.
 */
import { useCallback, useEffect, useState } from "react";
import { Button, Center, Paper, PasswordInput, Stack, TextInput, Title, Text, Group, Badge } from "@mantine/core";
import { api } from "../api";

const STEP_LABELS: Record<string, string> = {
  administrator: "Administrator account",
  storage: "Storage location",
  libraries: "Libraries",
  "download-engines": "Download engines",
  indexers: "Indexers",
  metadata: "Metadata providers",
  "vpn-policy": "VPN policy",
  "final-health": "Final health check",
};

const OPTIONAL = new Set(["download-engines", "indexers", "metadata", "vpn-policy"]);

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
  const [state, setState] = useState<OnboardingState | null>(null);

  const refresh = useCallback(async () => {
    try {
      setState(await api.onboarding());
    } catch {
      setState(null);
    }
  }, []);

  useEffect(() => {
    if (bootstrapped) void refresh();
  }, [bootstrapped, refresh]);

  const bootstrap = () => {
    setBusy(true);
    setError(null);
    api
      .bootstrapAdmin(username, password)
      .then(() => api.login(username, password))
      .then(() => setBootstrapped(true))
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(false));
  };

  const act = (stepId: string, action: "complete" | "skip") => {
    setBusy(true);
    setError(null);
    api
      .onboardStep(stepId, action)
      .then((next) => {
        setState(next);
        if (next.complete) onFinished();
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(false));
  };

  if (!bootstrapped) {
    return (
      <Center mih="100vh">
        <Paper shadow="sm" radius="md" p="xl" w={420}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              bootstrap();
            }}
          >
            <Stack gap="sm">
              <Title order={3}>Welcome to Tantalar</Title>
              <Text size="sm" c="dimmed">
                Create your administrator account to start guided setup. This is the only time this screen appears.
              </Text>
              <TextInput
                label="Username"
                name="username"
                required
                value={username}
                onChange={(e) => setUsername(e.currentTarget.value)}
              />
              <PasswordInput
                label="Password"
                name="password"
                data-testid="setup-password"
                description="At least 8 characters"
                required
                value={password}
                onChange={(e) => setPassword(e.currentTarget.value)}
              />
              {error ? (
                <div role="alert" style={{ color: "var(--mantine-color-red-6)" }}>
                  {error}
                </div>
              ) : null}
              <Button type="submit" loading={busy} data-testid="setup-create-admin">
                Create administrator
              </Button>
            </Stack>
          </form>
        </Paper>
      </Center>
    );
  }

  const steps = state?.steps ?? {};
  const stepIds = Object.keys(STEP_LABELS);
  const current = stepIds.find((id) => steps[id]?.status === "pending");

  return (
    <Center mih="100vh">
      <Paper shadow="sm" radius="md" p="xl" w={520}>
        <Stack gap="sm">
          <Title order={3}>Guided setup</Title>
          <Text size="sm" c="dimmed">
            Work through each step. You can leave and come back — your progress is saved.
          </Text>
          <Stack gap="xs" data-testid="setup-steps">
            {stepIds.map((id) => {
              const status = steps[id]?.status ?? "pending";
              return (
                <Group key={id} justify="space-between" data-testid={`setup-step-${id}`}>
                  <Group gap="xs">
                    <span>{STEP_LABELS[id]}</span>
                    {OPTIONAL.has(id) ? (
                      <Badge size="xs" variant="outline" color="gray">
                        optional
                      </Badge>
                    ) : null}
                  </Group>
                  {status === "pending" && id === current ? (
                    <Group gap="xs">
                      {OPTIONAL.has(id) ? (
                        <Button size="xs" variant="subtle" disabled={busy} onClick={() => act(id, "skip")}>
                          Skip for now
                        </Button>
                      ) : null}
                      <Button size="xs" data-testid={`setup-done-${id}`} disabled={busy} onClick={() => act(id, "complete")}>
                        Mark done
                      </Button>
                    </Group>
                  ) : (
                    <Badge color={status === "done" ? "green" : status === "skipped" ? "gray" : "blue"}>
                      {status === "done" ? "Done" : status === "skipped" ? "Skipped" : "Waiting"}
                    </Badge>
                  )}
                </Group>
              );
            })}
          </Stack>
          {error ? (
            <div role="alert" style={{ color: "var(--mantine-color-red-6)" }}>
              {error}
            </div>
          ) : null}
        </Stack>
      </Paper>
    </Center>
  );
}
