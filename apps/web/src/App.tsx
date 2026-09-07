/**
 * One authenticated product with two explicit surfaces: Media for watching
 * and Control for administration. Hash routes keep static hosting simple.
 */
import { CollectionUserContext } from "./admin/DenseGrid";
import { useCallback, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ActionIcon,
  AppShell,
  Box,
  Burger,
  Button,
  Container,
  Drawer,
  Modal,
  Group,
  NavLink,
  Paper,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { useDisclosure, useMediaQuery } from "@mantine/hooks";
import {
  IconBell,
  IconCalendar,
  IconChevronLeft,
  IconChevronRight,
  IconFilm,
  IconHouse,
  IconTv,
  IconWaveformPathEcg,
  IconRectanglePortraitAndArrowRight,
  type IconComponent,
} from "symbols-react";
import "./shell/navigation.css";
import { api, type UserAvatar } from "./api";
import { ProfilePicture, PictureEditor } from "./components/ProfilePicture";
import { BrandLogo } from "./components/BrandLogo";
import { ActionNotice, useActionFeedback } from "./components/ActionNotice";
import { CalendarPage, CatalogPage, HomePage } from "./pages/ProductPages";
import { MediaActivityPage } from "./pages/MediaActivityPage";
import { PlayerPage } from "./pages/PlayerPage";
import { SetupPage } from "./pages/SetupPage";
import { SignInPage } from "./pages/SignInPage";
import {
  ControlNavigation,
  ControlPage,
  isControlChild,
  isControlArea,
  type ControlArea,
  type ControlChild,
} from "./shell/ControlSurface";
import { ErrorBoundary } from "./shell/ErrorBoundary";
import { ClientIncidentReporter } from "./shell/ClientIncidentReporter";
import { ProductVersion } from "./shell/ProductVersion";
import { type ManagedReleaseTarget } from "./shell/OperationsViews";
import { ThemeEngineProvider } from "./theme/engine";
import { NotificationsPage, NotificationProvider } from "./notifications";

export type Route =
  | { name: "home" }
  | { name: "movies" }
  | { name: "series" }
  | { name: "calendar" }
  | { name: "activity" }
  | { name: "library" }
  | { name: "preferences" }
  | { name: "player"; fileId: string }
  | { name: "admin"; area: ControlArea; child?: ControlChild; release?: ManagedReleaseTarget };

const MEDIA_NAV = [
  { route: "home", label: "Home", icon: IconHouse },
  { route: "movies", label: "Movies", icon: IconFilm },
  { route: "series", label: "Series", icon: IconTv },
  { route: "calendar", label: "Upcoming", icon: IconCalendar },
  { route: "activity", label: "My activity", icon: IconWaveformPathEcg },
] as const satisfies ReadonlyArray<{ route: string; label: string; icon: IconComponent }>;

export function parseHash(hash = window.location.hash): Route {
  const path = hash.replace(/^#\/?/, "").split("?")[0]!;
  const watch = /^watch\/(.+)$/.exec(path);
  if (watch?.[1]) return { name: "player", fileId: decodeURIComponent(watch[1]) };

  const admin = /^admin(?:\/([^/]+))?(?:\/([^/]+))?$/.exec(path);
  const release = /^admin\/media\/releases\/(movie|series)\/([^/]+)(?:\/(S\d{2,3}E\d{2,4}))?$/.exec(path);
  if (release) return { name: "admin", area: "media", child: "managed", release: { kind: release[1] as "movie" | "series", id: decodeURIComponent(release[2]!), ...(release[3] ? { episodeKey: release[3] } : {}) } };
  if (admin) {
    const area = isControlArea(admin[1]) ? admin[1] : "overview";
    const requestedChild = area === "audit" && admin[2] === "trajectories" ? "trace" : admin[2];
    const child = isControlChild(area, requestedChild) ? requestedChild : undefined;
    return child ? { name: "admin", area, child } : { name: "admin", area };
  }

  // Old bookmarks now land in their matching Control area.
  if (path === "discover") return { name: "admin", area: "media", child: "discover" };
  if (path === "settings") return { name: "admin", area: "system" };
  for (const name of ["home", "movies", "series", "calendar", "activity", "library", "preferences"] as const) {
    if (path === name) return { name };
  }
  return { name: "home" };
}

export function hashFor(route: Route): string {
  switch (route.name) {
    case "player":
      return `/watch/${encodeURIComponent(route.fileId)}`;
    case "admin":
      if (route.release) return `/admin/media/releases/${route.release.kind}/${encodeURIComponent(route.release.id)}${route.release.episodeKey ? `/${route.release.episodeKey}` : ""}`;
      if (route.area === "overview") return "/admin";
      return `/admin/${route.area}${route.child ? `/${route.child}` : ""}`;
    case "home":
      return "/home";
    default:
      return `/${route.name}`;
  }
}

function ProductApp() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [route, setRoute] = useState<Route>(parseHash);
  const [managedReleaseTarget, setManagedReleaseTarget] = useState<ManagedReleaseTarget | null>(null);
  const [role, setRole] = useState("");
  const [userId, setUserId] = useState<string | null>(null);
  const [username, setUsername] = useState("");
  const [avatar, setAvatar] = useState<UserAvatar>();
  const [profileOpen, setProfileOpen] = useState(false);
  const [signOutOpen, setSignOutOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const profile = useQuery({ queryKey: ["profile", userId], queryFn: () => api.userProfile(userId!), enabled: signedIn === true && !!userId });
  const [accountNotice, setAccountNotice, accountSeverity, accountRevision] = useActionFeedback();
  const [navOpen, { toggle: toggleNav, close: closeNav }] = useDisclosure(false);
  const isDesktop = useMediaQuery("(min-width: 48em)", false, { getInitialValueInEffect: false });
  const [desktopNavCollapsed, setDesktopNavCollapsed] = useState(false);
  const [bootstrapRequired, setBootstrapRequired] = useState<boolean | null>(null);
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null);

  const refreshSession = useCallback(() => {
    void api
      .me()
      .then((response) => {
        setSignedIn(response.user !== null);
        setRole(response.user?.role ?? "");
        setUserId(response.user?.id ?? null);
        setUsername(response.user?.username ?? "");
        setAvatar(response.user?.avatar);
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
    refreshSession();
  }, [refreshSession]);

  useEffect(() => {
    if (!userId) {
      setDesktopNavCollapsed(false);
      return;
    }
    try {
      setDesktopNavCollapsed(localStorage.getItem(`tantalar.navigation.collapsed.${userId}`) === "true");
    } catch {
      setDesktopNavCollapsed(false);
    }
  }, [userId]);

  useEffect(() => {
    void api
      .bootstrapStatus()
      .then((state) => setBootstrapRequired(state.required))
      .catch(() => setBootstrapRequired(false));
  }, []);

  useEffect(() => {
    if (signedIn !== true || bootstrapRequired !== false) {
      setNeedsSetup(null);
      return;
    }

    let active = true;
    void api
      .onboarding()
      .then((state) => {
        if (active) setNeedsSetup(!state.complete);
      })
      .catch(() => {
        // Fail closed into the resumable setup view instead of bypassing it.
        if (active) setNeedsSetup(true);
      });

    return () => {
      active = false;
    };
  }, [bootstrapRequired, signedIn]);

  useEffect(() => {
    const onHashChange = () => {
      setRoute(parseHash());
      closeNav();
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [closeNav]);

  useEffect(() => {
    const path = window.location.hash.replace(/^#\/?/, "");
    if (path === "discover") {
      window.history.replaceState(null, "", `#${hashFor({ name: "admin", area: "media", child: "discover" })}`);
    } else if (path === "admin/audit/trajectories") {
      window.history.replaceState(null, "", `#${hashFor({ name: "admin", area: "audit", child: "trace" })}`);
    }
  }, [route]);

  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const onlineNow = () => setOnline(true);
    const offlineNow = () => setOnline(false);
    window.addEventListener("online", onlineNow);
    window.addEventListener("offline", offlineNow);
    return () => {
      window.removeEventListener("online", onlineNow);
      window.removeEventListener("offline", offlineNow);
    };
  }, []);

  const navigate = useCallback((next: Route) => {
    window.location.hash = hashFor(next);
    setRoute(next);
    closeNav();
  }, [closeNav]);

  if (
    signedIn === null
    || bootstrapRequired === null
    || (signedIn && bootstrapRequired === false && needsSetup === null)
  ) {
    return (
      <Box mih="100vh" className="tantalar-loading" aria-busy="true">
        <BrandLogo />
        <Title order={3} c="dimmed">Loading Tantalar…</Title>
      </Box>
    );
  }

  if (bootstrapRequired) {
    return (
      <SetupPage
        bootstrapRequired
        onFinished={() => {
          setBootstrapRequired(false);
          setNeedsSetup(false);
          refreshSession();
        }}
      />
    );
  }

  if (!signedIn) return <SignInPage onSignedIn={refreshSession} />;

  if (needsSetup) {
    return (
      <SetupPage
        bootstrapRequired={false}
        onFinished={() => setNeedsSetup(false)}
      />
    );
  }

  const isAdmin = role === "admin";
  const isControl = isAdmin && route.name === "admin";
  const railCollapsed = isDesktop && desktopNavCollapsed;
  const routeKey = route.name === "admin" ? `admin-${route.area}-${route.child ?? "root"}` : route.name;

  const page = (() => {
    switch (route.name) {
      case "player":
        return (
          <Stack gap="sm">
            <Button variant="subtle" onClick={() => navigate({ name: "home" })} w="fit-content">
              ← Back to Media
            </Button>
            <PlayerPage fileId={route.fileId} />
          </Stack>
        );
      case "movies":
        return <CatalogPage kindFilter="movie" heading="Movies" onWatch={(fileId) => navigate({ name: "player", fileId })} />;
      case "series":
        return <CatalogPage kindFilter="series" heading="Series" onWatch={(fileId) => navigate({ name: "player", fileId })} />;
      case "calendar":
        return <CalendarPage />;
      case "activity":
        return <MediaActivityPage onWatch={(fileId) => navigate({ name: "player", fileId })} />;
      case "library":
        return <CatalogPage heading="Library" onWatch={(fileId) => navigate({ name: "player", fileId })} />;
      case "preferences":
        return <NotificationsPage isAdmin={isAdmin} />;
      case "admin":
        if (!isAdmin) {
          return (
            <Paper className="tantalar-access-state" withBorder p="xl" radius="md" role="alert">
              <Title order={2}>Administrator access required</Title>
              <Text c="dimmed" mt="xs">Control is only available to administrator accounts.</Text>
              <Button mt="lg" onClick={() => navigate({ name: "home" })}>Back to Media</Button>
            </Paper>
          );
        }
        return (
          <ControlPage
            area={route.area}
            child={route.child}
            release={route.release}
            adminId={userId}
            managedReleaseTarget={managedReleaseTarget}
            onManagedReleaseTargetChange={setManagedReleaseTarget}
            onNavigate={(area, child) => navigate(child ? { name: "admin", area, child } : { name: "admin", area })}
          />
        );
      default:
        return <HomePage onWatch={(fileId) => navigate({ name: "player", fileId })} />;
    }
  })();

  const mediaNavigation = MEDIA_NAV.map((item) => {
    const Icon = item.icon;
    return (
      <NavLink
        key={item.route}
        component="button"
        className={`tantalar-nav-link${railCollapsed ? " tantalar-nav-link--rail" : ""}`}
        data-testid={`nav-${item.route}`}
        label={railCollapsed ? undefined : item.label}
        aria-label={item.label}
        title={railCollapsed ? item.label : undefined}
        leftSection={<Icon className="tantalar-nav-icon" fill="currentColor" aria-hidden="true" />}
        active={route.name === item.route}
        aria-current={route.name === item.route ? "page" : undefined}
        onClick={() => navigate({ name: item.route })}
      />
    );
  });

  const toggleDesktopNavigation = () => {
    const next = !desktopNavCollapsed;
    setDesktopNavCollapsed(next);
    if (!userId) return;
    try {
      localStorage.setItem(`tantalar.navigation.collapsed.${userId}`, String(next));
    } catch {
      // Browser storage can be unavailable. The current session still works.
    }
  };

  return (
    <CollectionUserContext.Provider key={userId ?? "anonymous"} value={userId}>
    <ThemeEngineProvider adminId={userId}>
      <NotificationProvider userId={userId} isAdmin={isAdmin} navigate={navigate}>
        <ClientIncidentReporter enabled={isAdmin} />
        <Button component="a" href="#main-content" variant="light" data-testid="skip-link" className="tantalar-skip-link">
          Skip to content
        </Button>
        <AppShell
          className="tantalar-shell"
          header={{ height: 64 }}
          navbar={{ width: railCollapsed ? 68 : isControl ? 256 : 220, breakpoint: "sm", collapsed: { mobile: !navOpen } }}
          padding={0}
        >
          <AppShell.Header className="tantalar-shell-header">
          <Group h="100%" px={{ base: "sm", sm: "md" }} justify="space-between" wrap="nowrap" gap="sm">
            <Group gap="sm" wrap="nowrap">
              <Burger
                opened={navOpen}
                onClick={toggleNav}
                hiddenFrom="sm"
                aria-label="Navigation menu"
                aria-expanded={navOpen}
                aria-controls="tantalar-navbar"
              />
              <div className="tantalar-brand">
                <a href="#/" aria-label="Tantalar home"><BrandLogo /></a>
                <Text size="xs" className="tantalar-surface-name">{isControl ? "Control" : "Media"}</Text>
                <ProductVersion />
              </div>
            </Group>
            <Group gap="xs" wrap="nowrap">
              {isControl ? (
                <Button aria-label="Back to Media" variant="subtle" size="compact-sm" data-testid="back-to-media" onClick={() => navigate({ name: "home" })}>
                  <span className="tantalar-back-to-media__full">Back to Media</span>
                  <span className="tantalar-back-to-media__compact" aria-hidden="true">Media</span>
                </Button>
              ) : isAdmin ? (
                <Button variant="light" size="compact-sm" data-testid="nav-admin" onClick={() => navigate({ name: "admin", area: "overview" })}>
                  Control
                </Button>
              ) : null}
            </Group>
          </Group>
          </AppShell.Header>

          <AppShell.Navbar
          id="tantalar-navbar"
          className="tantalar-shell-navbar"
          aria-label={isControl ? "Control navigation" : "Media navigation"}
        >
          <div className="tantalar-nav-header" data-collapsed={railCollapsed || undefined}>
            {isDesktop ? (
              <ActionIcon
                variant="subtle"
                size="lg"
                className="tantalar-nav-collapse"
                aria-label={railCollapsed ? "Expand navigation" : "Collapse navigation"}
                aria-expanded={!railCollapsed}
                aria-controls="tantalar-navbar"
                title={railCollapsed ? "Expand navigation" : "Collapse navigation"}
                onClick={toggleDesktopNavigation}
              >
                {railCollapsed
                  ? <IconChevronRight className="tantalar-nav-icon" aria-hidden="true" />
                  : <IconChevronLeft className="tantalar-nav-icon" aria-hidden="true" />}
              </ActionIcon>
            ) : null}
          </div>
          {isControl && route.name === "admin" ? (
            <ControlNavigation
              area={route.area}
              child={route.child}
              collapsed={railCollapsed}
              onNavigate={(area, child) => navigate(child ? { name: "admin", area, child } : { name: "admin", area })}
            />
          ) : (
            <Stack gap={2} p="xs" className="tantalar-navigation" data-collapsed={railCollapsed}>
              {mediaNavigation}
            </Stack>
          )}
          <div className="tantalar-navigation-footer tantalar-account-footer" data-collapsed={railCollapsed || undefined}>
            <button type="button" className="tantalar-account-footer__profile" aria-label={`Edit profile for ${username}`} title={railCollapsed ? username : undefined} onClick={() => setProfileOpen(true)}>
              <span className="tantalar-account-footer__avatar"><ProfilePicture avatar={profile.data?.user.avatar ?? avatar} name={username} decorative /></span>
              {!railCollapsed ? <span className="tantalar-account-footer__name">{username}</span> : null}
            </button>
            <ActionIcon
              variant="subtle" size="lg"
              data-testid="nav-notifications"
              aria-label="Notifications"
              title="Notifications"
              aria-current={route.name === "preferences" || (isControl && route.area === "system" && route.child === "notifications") ? "page" : undefined}
              onClick={() => navigate(isControl
                ? { name: "admin", area: "system", child: "notifications" }
                : { name: "preferences" })}
            ><IconBell className="tantalar-nav-icon" fill="currentColor" aria-hidden="true" /></ActionIcon>
            <ActionIcon variant="subtle" size="lg" aria-label="Sign out" title="Sign out" onClick={() => setSignOutOpen(true)}>
              <IconRectanglePortraitAndArrowRight className="tantalar-nav-icon" aria-hidden="true" />
            </ActionIcon>
          </div>
          </AppShell.Navbar>

          <AppShell.Main id="main-content" className="tantalar-shell-main">
          {!online ? (
            <div role="alert" data-testid="offline-banner" className="tantalar-offline-banner">
              You are offline. Showing the last loaded information.
            </div>
          ) : null}
          <Container fluid className="tantalar-page-container">
            <ErrorBoundary
              resetKey={routeKey}
              title="This area could not be displayed"
              actionLabel="Back to Media home"
              onReset={() => navigate({ name: "home" })}
            >
              {page}
            </ErrorBoundary>
          </Container>
          </AppShell.Main>
        </AppShell>
        <ActionNotice message={accountNotice} title="Account" severity={accountSeverity} revision={accountRevision} />
        <Modal opened={signOutOpen} onClose={() => { if (!signingOut) setSignOutOpen(false); }} title="Sign out of Tantalar?" closeButtonProps={{ "aria-label": "Close sign out confirmation" }} centered size="sm">
          <Stack>
            <Text size="sm">You’ll need to sign in again on this device.</Text>
            <Group justify="flex-end">
              <Button variant="default" disabled={signingOut} onClick={() => setSignOutOpen(false)}>Cancel</Button>
              <Button loading={signingOut} onClick={async () => {
                setSigningOut(true);
                try {
                  await api.logout();
                  setSignOutOpen(false);
                  setProfileOpen(false);
                  setSignedIn(false);
                  setUserId(null);
                } catch {
                  setAccountNotice("Sign out failed. Try again.", "error");
                } finally {
                  setSigningOut(false);
                }
              }}>Sign out</Button>
            </Group>
          </Stack>
        </Modal>
        <Drawer opened={profileOpen} onClose={() => setProfileOpen(false)} title="Your profile" closeButtonProps={{ "aria-label": "Close profile" }} position="left" size="sm">
          {userId ? <Stack><Text fw={600}>{username}</Text><Text size="sm" c="dimmed">{role === "admin" ? "Administrator" : "Viewer"}</Text><PictureEditor key={`${userId}:${profileOpen}`} userId={userId} username={username} avatar={profile.data?.user.avatar ?? avatar} onSaved={setAvatar} /></Stack> : null}
        </Drawer>
      </NotificationProvider>
    </ThemeEngineProvider>
    </CollectionUserContext.Provider>
  );
}

export function App() {
  return (
    <ErrorBoundary
      title="Tantalar could not start"
      actionLabel="Reload Tantalar"
      onReset={() => window.location.reload()}
    >
      <ProductApp />
    </ErrorBoundary>
  );
}
