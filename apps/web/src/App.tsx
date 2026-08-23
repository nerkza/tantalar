/**
 * App shell: session-gated routing between sign-in, the library viewer and
 * the phase 6 admin console. Routing is hash-based and hand-rolled
 * (TanStack-Router-shaped route state) so the app works from any static host
 * without server rewrites; the ADR-0012 stack contract is honoured for query
 * + theming. The ThemeEngineProvider applies the shared `--tantalar-*` token
 * layer to BOTH the admin UI and the player.
 */
import { useCallback, useEffect, useState } from "react";
import { AppShell, Container, Title, Button, Stack, Group, Box } from "@mantine/core";
import { api } from "./api";
import { SignInPage } from "./pages/SignInPage";
import { LibraryPage } from "./pages/LibraryPage";
import { PlayerPage } from "./pages/PlayerPage";
import { AdminTabs } from "./admin/views";
import { ThemeEngineProvider } from "./theme/engine";

export type Route =
  | { name: "library" }
  | { name: "player"; fileId: string }
  | { name: "admin" };

function parseHash(): Route {
  const h = window.location.hash.replace(/^#\/?/, "");
  const m = /^watch\/(.+)$/.exec(h);
  if (m && m[1]) return { name: "player", fileId: decodeURIComponent(m[1]) };
  if (/^admin$/.test(h)) return { name: "admin" };
  return { name: "library" };
}

export function App() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null); // null = checking
  const [route, setRoute] = useState<Route>(parseHash);
  const [role, setRole] = useState<string>("");
  const [userId, setUserId] = useState<string | null>(null);

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    // Session probe: /api/v1/auth/me answers 401 without a session and
    // reports the user id + role with one. Falls back to a history probe
    // when the endpoint is unavailable (older servers).
    api
      .me()
      .then((r) => {
        setSignedIn(r.user !== null);
        setRole(r.user?.role ?? "");
        setUserId(r.user?.id ?? null);
      })
      .catch(() =>
        api
          .history()
          .then(() => {
            setSignedIn(true);
            setRole("");
          })
          .catch(() => setSignedIn(false)),
      );
  }, []);

  const navigate = useCallback((r: Route) => {
    window.location.hash =
      r.name === "player"
        ? `/watch/${encodeURIComponent(r.fileId)}`
        : r.name === "admin"
          ? "/admin"
          : "/library";
    setRoute(r);
  }, []);

  if (signedIn === null) {
    return (
      <Box mih="100vh" style={{ display: "grid", placeItems: "center" }} aria-busy="true">
        <Title order={3} c="dimmed">Loading…</Title>
      </Box>
    );
  }

  if (!signedIn) {
    return (
      <SignInPage
        onSignedIn={() => {
          void api
            .me()
            .then((r) => {
              setSignedIn(r.user !== null);
              setRole(r.user?.role ?? "");
              setUserId(r.user?.id ?? null);
            })
            .catch(() => setSignedIn(true));
        }}
      />
    );
  }

  return (
    <ThemeEngineProvider adminId={userId}>
      <AppShell header={{ height: 56 }} padding="md">
        <AppShell.Header>
          <Group h="100%" px="md" justify="space-between">
            <Title order={4}>Tantalar</Title>
            <Group gap="sm">
              {role === "admin" ? (
                <Button
                  variant="subtle"
                  data-testid="nav-admin"
                  aria-current={route.name === "admin"}
                  onClick={() => navigate({ name: "admin" })}
                >
                  Admin
                </Button>
              ) : null}
              <Button
                variant="subtle"
                data-testid="nav-library"
                onClick={() => navigate({ name: "library" })}
              >
                Library
              </Button>
              <Button
                variant="subtle"
                onClick={() => {
                  void api.logout().finally(() => setSignedIn(false));
                }}
              >
                Sign out
              </Button>
            </Group>
          </Group>
        </AppShell.Header>
        <AppShell.Main>
          <Container size="xl">
            {route.name === "library" ? (
              <LibraryPage onWatch={(fileId) => navigate({ name: "player", fileId })} />
            ) : route.name === "player" ? (
              <Stack gap="sm">
                <Button variant="subtle" onClick={() => navigate({ name: "library" })}>
                  ← Back to library
                </Button>
                <PlayerPage fileId={route.fileId} />
              </Stack>
            ) : (
              <AdminTabs adminId={userId} />
            )}
          </Container>
        </AppShell.Main>
      </AppShell>
    </ThemeEngineProvider>
  );
}
