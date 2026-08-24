/**
 * Wave 8 product shell: information architecture Home, Movies, Series,
 * Calendar, Activity, and Settings. Administration stays role-gated behind
 * #/admin (admin role only). Routing is hash-based so the app works from any
 * static host without server rewrites; the ThemeEngineProvider applies the
 * shared `--tantalar-*` token layer to the whole product.
 */
import { useCallback, useEffect, useState } from "react";
import { AppShell, Burger, Button, Container, Group, NavLink, Stack, Title, Box, Text } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { api } from "./api";
import { SignInPage } from "./pages/SignInPage";
import { SetupPage } from "./pages/SetupPage";
import { PlayerPage } from "./pages/PlayerPage";
import { AdminTabs } from "./admin/views";
import { CalendarPage, CatalogPage, HomePage } from "./pages/ProductPages";
import { SettingsPage } from "./pages/SettingsPage";
import { ThemeEngineProvider } from "./theme/engine";

export type Route =
  | { name: "home" }
  | { name: "movies" }
  | { name: "series" }
  | { name: "calendar" }
  | { name: "activity" }
  | { name: "settings" }
  | { name: "library" }
  | { name: "player"; fileId: string }
  | { name: "admin" };

const NAV: ReadonlyArray<{ route: Route["name"]; label: string }> = [
  { route: "home", label: "Home" },
  { route: "movies", label: "Movies" },
  { route: "series", label: "Series" },
  { route: "calendar", label: "Calendar" },
  { route: "activity", label: "Activity" },
  { route: "settings", label: "Settings" },
];

function parseHash(): Route {
  const h = window.location.hash.replace(/^#\/?/, "");
  const m = /^watch\/(.+)$/.exec(h);
  if (m && m[1]) return { name: "player", fileId: decodeURIComponent(m[1]) };
  if (/^admin$/.test(h)) return { name: "admin" };
  for (const n of ["home", "movies", "series", "calendar", "activity", "settings", "library"] as const) {
    if (h === n) return { name: n };
  }
  return { name: "home" };
}

function hashFor(r: Route): string {
  switch (r.name) {
    case "player": return `/watch/${encodeURIComponent(r.fileId)}`;
    case "admin": return "/admin";
    case "home": return "/home";
    default: return `/${r.name}`;
  }
}

export function App() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null); // null = checking
  const [route, setRoute] = useState<Route>(parseHash);
  const [role, setRole] = useState<string>("");
  const [userId, setUserId] = useState<string | null>(null);
  const [navOpen, { toggle: toggleNav, close: closeNav }] = useDisclosure(false);
  // Wave 2: null = not probed yet; true = first-run setup (no admin yet) or
  // guided onboarding still has pending steps; false = normal app.
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null);

  const refreshSession = useCallback(() => {
    void api
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

  useEffect(() => {
    // Session probe: /api/v1/auth/me answers 401 without a session and
    // reports the user id + role with one. Falls back to a history probe
    // when the endpoint is unavailable (older servers).
    refreshSession();
  }, [refreshSession]);

  useEffect(() => {
    // Setup probe (wave 2): an unauthenticated onboarding read means the
    // install still needs first-run setup or has pending wizard steps. Any
    // other outcome (signed-in session, older server without the route,
    // network error) leaves needsSetup false so existing behaviour holds.
    fetch("/api/v1/onboarding")
      .then((r) => (r.ok ? (r.json() as Promise<{ complete: boolean }>) : null))
      .then((s) => setNeedsSetup(s !== null && !s.complete))
      .catch(() => setNeedsSetup(false));
  }, []);

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Wave 9 (TAN-036): truthful offline detection so views can distinguish
  // "no data" from "no connection" without wiping the last usable view.
  const [online, setOnline] = useState<boolean>(navigator.onLine);
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);

  const navigate = useCallback((r: Route) => {
    window.location.hash = hashFor(r);
    setRoute(r);
    closeNav();
  }, [closeNav]);

  if (signedIn === null || needsSetup === null) {
    return (
      <Box mih="100vh" style={{ display: "grid", placeItems: "center" }} aria-busy="true">
        <Title order={3} c="dimmed">Loading…</Title>
      </Box>
    );
  }

  // Wave 2: first-run bootstrap + guided onboarding come before sign-in.
  if (needsSetup && !signedIn) {
    return (
      <SetupPage
        onFinished={() => {
          setNeedsSetup(false);
          refreshSession();
        }}
      />
    );
  }

  if (!signedIn) {
    return <SignInPage onSignedIn={refreshSession} />;
  }

  const isAdmin = role === "admin";

  const page = (() => {
    switch (route.name) {
      case "player":
        return (
          <Stack gap="sm">
            <Button variant="subtle" onClick={() => navigate({ name: "home" })} w="fit-content">
              ← Back to home
            </Button>
            <PlayerPage fileId={route.fileId} />
          </Stack>
        );
      case "movies":
        return <CatalogPage kindFilter="movie" heading="Movies" onWatch={(f) => navigate({ name: "player", fileId: f })} />;
      case "series":
        return <CatalogPage kindFilter="series" heading="Series" onWatch={(f) => navigate({ name: "player", fileId: f })} />;
      case "calendar":
        return <CalendarPage />;
      case "activity":
        return (
          <Stack gap="sm" data-testid="activity-page">
            <Title order={3}>Activity</Title>
            <AdminTabs adminId={userId} />
          </Stack>
        );
      case "settings":
        return <SettingsPage adminId={userId} isAdmin={isAdmin} />;
      case "library":
      case "admin":
        return (
          <Stack gap="sm">
            {route.name === "admin" ? <AdminTabs adminId={userId} /> : null}
            {/* Legacy library grid remains reachable at #/library. */}
            {route.name === "library" ? (
              <CatalogPage heading="Library" onWatch={(f) => navigate({ name: "player", fileId: f })} />
            ) : null}
          </Stack>
        );
      default:
        return <HomePage onWatch={(f) => navigate({ name: "player", fileId: f })} />;
    }
  })();

  const navLinks = NAV.map((n) => (
    <NavLink
      key={n.route}
      component="button"
      data-testid={`nav-${n.route}`}
      label={n.label}
      active={route.name === n.route}
      aria-current={route.name === n.route ? "page" : undefined}
      onClick={() => navigate({ name: n.route } as Route)}
      style={{ color: "var(--tantalar-color-text)" }}
    />
  ));

  return (
    <ThemeEngineProvider adminId={userId}>
      {/* Wave 9 (TAN-037): keyboard users can jump straight to the content. */}
      <Button
        component="a"
        href="#main-content"
        variant="light"
        data-testid="skip-link"
        style={{
          position: "absolute",
          left: 8,
          top: -48,
          zIndex: 300,
          transition: "top 120ms ease",
        }}
        onFocus={(e) => {
          (e.currentTarget as HTMLElement).style.top = "8px";
        }}
        onBlur={(e) => {
          (e.currentTarget as HTMLElement).style.top = "-48px";
        }}
        w="fit-content"
      >
        Skip to content
      </Button>
      <AppShell
        header={{ height: 56 }}
        navbar={{
          width: 200,
          breakpoint: "sm",
          collapsed: { mobile: !navOpen },
        }}
        padding="md"
      >
        <AppShell.Header>
          <Group h="100%" px="xs" justify="space-between" wrap="nowrap" gap="xs">
            <Group gap="sm" wrap="nowrap">
              <Burger opened={navOpen} onClick={toggleNav} hiddenFrom="sm" aria-label="Navigation menu" aria-expanded={navOpen} aria-controls="tantalar-navbar" />
              <Title order={4}>Tantalar</Title>
            </Group>
            <Group gap="xs" wrap="nowrap">
              {isAdmin ? (
                <Button
                  variant="subtle"
                  size="compact-sm"
                  data-testid="nav-admin"
                  aria-current={route.name === "admin" ? "page" : undefined}
                  onClick={() => navigate({ name: "admin" })}
                >
                  Admin
                </Button>
              ) : null}
              <Button
                variant="subtle"
                size="compact-sm"
                onClick={() => {
                  void api.logout().finally(() => setSignedIn(false));
                }}
              >
                Sign out
              </Button>
            </Group>
          </Group>
        </AppShell.Header>

        {/* Wave 9 (TAN-036): an offline notice appears without wiping the
            current view; it disappears when connectivity returns. */}
        {!online ? (
          <div role="alert" data-testid="offline-banner" style={{ background: "var(--tantalar-color-warning, #c78a1d)", color: "#111", padding: "6px 12px", textAlign: "center" }}>
            You are offline. Showing the last loaded information.
          </div>
        ) : null}

        <AppShell.Navbar id="tantalar-navbar" aria-label="Main navigation" style={{ background: "var(--tantalar-color-surface)", borderColor: "var(--tantalar-color-border)" }}>
          <Stack gap={2} p="xs">{navLinks}</Stack>
        </AppShell.Navbar>

        <AppShell.Main id="main-content">
          <Container size="xl" px={{ base: 8, sm: "md" }}>{page}</Container>
        </AppShell.Main>
      </AppShell>
    </ThemeEngineProvider>
  );
}
