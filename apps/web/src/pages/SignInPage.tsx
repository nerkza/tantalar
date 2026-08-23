import { useState } from "react";
import { Button, Center, Paper, PasswordInput, Stack, TextInput, Title } from "@mantine/core";
import { api } from "../api";

export function SignInPage({ onSignedIn }: { onSignedIn: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <Center mih="100vh">
      <Paper shadow="sm" radius="md" p="xl" w={380}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            api
              .login(username, password)
              .then(() => onSignedIn())
              .catch((err: Error) => setError(err.message))
              .finally(() => setBusy(false));
          }}
        >
          <Stack gap="sm">
            <Title order={3}>Sign in</Title>
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
              required
              value={password}
              onChange={(e) => setPassword(e.currentTarget.value)}
            />
            {error ? (
              <div role="alert" style={{ color: "var(--mantine-color-red-6)" }}>
                {error}
              </div>
            ) : null}
            <Button type="submit" loading={busy}>
              Sign in
            </Button>
          </Stack>
        </form>
      </Paper>
    </Center>
  );
}
