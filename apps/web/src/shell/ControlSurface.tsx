import { useEffect, useState } from "react";
import { ReleaseSearchPage } from "./ReleaseSearchPage";
import { JobsPage } from "./JobsPage";
import { QualityPage } from "./QualityPage";
import {
  NavLink,
  Stack,
  Tabs,
  Text,
  Title,
} from "@mantine/core";
import {
  IconBooksVertical,
  IconGearshape,
  IconLink,
  IconMinus,
  IconPerson2,
  IconPuzzlepieceExtension,
  IconSquareGrid2x2,
  IconTextDocument,
  IconTrayAndArrowDown,
  IconTv,
  type IconComponent,
} from "symbols-react";
import {
  ActivityView,
  AuditView,
  PluginsView,
  UsersView,
} from "../admin/views";
import { LibraryManager } from "../components/LibraryManager";
import { NotificationsPage } from "../notifications";
import { AppearanceSettings, IntegrationsSection, McpSettings } from "../pages/SettingsPage";
import {
  AcquisitionControl,
  DiscoveryView,
  ManagedTitlesControl,
  MetadataControl,
  PlaybackControl,
  type AcquisitionSection,
  type ManagedReleaseTarget,
} from "./OperationsViews";
import { OverviewDashboard, SystemHealthDashboard } from "./HealthViews";

export const CONTROL_AREAS = [
  { value: "overview", label: "Overview", description: "", icon: IconSquareGrid2x2 },
  { value: "media", label: "Media", description: "Discovery, libraries and metadata", icon: IconBooksVertical },
  { value: "acquisition", label: "Acquisition", description: "Search, downloads and quality", icon: IconTrayAndArrowDown },
  { value: "jobs", label: "Jobs", description: "Schedules and run history", icon: IconGearshape },
  { value: "integrations", label: "Integrations", description: "API access, webhooks and MCP", icon: IconLink },
  { value: "extensions", label: "Extensions", description: "Installed capabilities", icon: IconPuzzlepieceExtension },
  { value: "people", label: "People", description: "Users and access", icon: IconPerson2 },
  { value: "playback", label: "Playback", description: "Sessions, transcodes and playback policy", icon: IconTv },
  { value: "audit", label: "Audit", description: "", icon: IconTextDocument },
  { value: "system", label: "System", description: "Health and appearance", icon: IconGearshape },
] as const satisfies ReadonlyArray<{ value: string; label: string; description: string; icon: IconComponent }>;

export type ControlArea = (typeof CONTROL_AREAS)[number]["value"];

export const CONTROL_CHILDREN = {
  media: [
    { value: "discover", label: "Discover" },
    { value: "managed", label: "Managed titles" },
    { value: "libraries", label: "Libraries" },
    { value: "metadata", label: "Metadata" },
  ],
  acquisition: [
    { value: "indexers", label: "Indexers" },
    { value: "usenet", label: "Usenet" },
    { value: "torrent", label: "Torrents" },
    { value: "vpn", label: "VPN" },
    { value: "downloads", label: "Downloads" },
    { value: "quality", label: "Quality management" },
  ],
  integrations: [
    { value: "overview", label: "API and webhooks" },
    { value: "mcp", label: "MCP" },
  ],
  audit: [
    { value: "log", label: "Audit log" },
    { value: "trace", label: "Trace" },
    { value: "mcp", label: "MCP calls" },
  ],
  system: [
    { value: "health", label: "Health" },
    { value: "appearance", label: "Appearance" },
    { value: "notifications", label: "Notifications" },
  ],
} as const;

export type ControlChild =
  (typeof CONTROL_CHILDREN)[keyof typeof CONTROL_CHILDREN][number]["value"];

type ControlChildItem = { readonly value: ControlChild; readonly label: string };

export function isControlArea(value: string | undefined): value is ControlArea {
  return CONTROL_AREAS.some((area) => area.value === value);
}

function childrenFor(area: ControlArea): readonly ControlChildItem[] {
  if (area === "media" || area === "acquisition" || area === "integrations" || area === "audit" || area === "system") {
    return CONTROL_CHILDREN[area] as readonly ControlChildItem[];
  }
  return [];
}

export function defaultControlChild(area: ControlArea): ControlChild | undefined {
  return childrenFor(area)[0]?.value;
}

export function isControlChild(area: ControlArea, value: string | undefined): value is ControlChild {
  return value !== undefined && childrenFor(area).some((item) => item.value === value);
}

export function ControlNavigation({
  area,
  child,
  collapsed = false,
  onNavigate,
}: {
  readonly area: ControlArea;
  readonly child?: ControlChild;
  readonly collapsed?: boolean;
  readonly onNavigate: (area: ControlArea, child?: ControlChild) => void;
}) {
  const [expandedArea, setExpandedArea] = useState<ControlArea | null>(() =>
    childrenFor(area).length > 0 ? area : null,
  );
  useEffect(() => {
    setExpandedArea(childrenFor(area).length > 0 ? area : null);
  }, [area]);

  if (collapsed) {
    return (
      <Stack gap={2} p="xs" className="tantalar-navigation" data-collapsed="true">
        {CONTROL_AREAS.map((item) => {
          const AreaIcon = item.icon;
          return (
            <NavLink
              key={item.value}
              component="button"
              className="tantalar-nav-link tantalar-nav-link--rail"
              data-testid={`control-nav-${item.value}`}
              aria-label={item.label}
              title={item.label}
              leftSection={<AreaIcon className="tantalar-nav-icon" fill="currentColor" aria-hidden="true" />}
              active={area === item.value}
              aria-current={area === item.value ? "page" : undefined}
              onClick={() => onNavigate(item.value)}
            />
          );
        })}
      </Stack>
    );
  }

  return (
    <Stack gap={2} p="xs" className="tantalar-navigation" data-collapsed="false">
      {CONTROL_AREAS.map((item) => {
        const AreaIcon = item.icon;
        const children = childrenFor(item.value).filter((nested) => nested.value !== "notifications");
        const expanded = expandedArea === item.value && children.length > 0;
        const childrenId = `control-nav-${item.value}-children`;
        return (
          <div className="tantalar-nav-group" key={item.value}>
            <NavLink
              component="button"
              className="tantalar-nav-link"
              data-testid={`control-nav-${item.value}`}
              label={item.label}
              leftSection={<AreaIcon className="tantalar-nav-icon" fill="currentColor" aria-hidden="true" />}
              active={area === item.value}
              aria-current={area === item.value && children.length === 0 ? "page" : undefined}
              aria-expanded={children.length > 0 ? expanded : undefined}
              aria-controls={children.length > 0 ? childrenId : undefined}
              rightSection={children.length > 0 ? <span aria-hidden="true">{expanded ? "−" : "+"}</span> : undefined}
              onClick={() => {
                if (children.length === 0) {
                  onNavigate(item.value);
                  return;
                }
                if (area === item.value) {
                  setExpandedArea((current) => current === item.value ? null : item.value);
                  return;
                }
                setExpandedArea(item.value);
                onNavigate(item.value, defaultControlChild(item.value));
              }}
            />
            {children.length > 0 ? (
              <div className="tantalar-nav-children" id={childrenId} hidden={!expanded}>
                {children.map((nested) => (
                  <NavLink
                    key={nested.value}
                    component="button"
                    className="tantalar-nav-link tantalar-nav-link--child"
                    data-testid={`control-nav-${item.value}-${nested.value}`}
                    label={nested.label}
                    leftSection={<IconMinus className="tantalar-nav-icon" fill="currentColor" aria-hidden="true" />}
                    active={area === item.value && (child ?? defaultControlChild(area)) === nested.value}
                    aria-current={area === item.value && (child ?? defaultControlChild(area)) === nested.value ? "page" : undefined}
                    onClick={() => onNavigate(item.value, nested.value)}
                  />
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </Stack>
  );
}

function People() {
  return <UsersView />;
}

type AuditSection = "log" | "trace" | "mcp";

function Audit({ child, onChildChange }: { readonly child?: ControlChild; readonly onChildChange: (child: AuditSection) => void }) {
  const requested: AuditSection = child === "trace" || child === "mcp" ? child : "log";
  const [active, setActive] = useState<AuditSection>(requested);
  useEffect(() => setActive(requested), [requested]);

  return (
    <Tabs
      value={active}
      onChange={(value) => {
        const next: AuditSection = value === "trace" || value === "mcp" ? value : "log";
        setActive(next);
        onChildChange(next);
      }}
      keepMounted={false}
    >
      <Tabs.List aria-label="Audit views">
        <Tabs.Tab value="log">Audit log</Tabs.Tab>
        <Tabs.Tab value="trace">Trace</Tabs.Tab>
        <Tabs.Tab value="mcp">MCP calls</Tabs.Tab>
      </Tabs.List>
      <Tabs.Panel value="log" pt="md"><AuditView /></Tabs.Panel>
      <Tabs.Panel value="trace" pt="md"><ActivityView /></Tabs.Panel>
      <Tabs.Panel value="mcp" pt="md"><AuditView typePrefix="dev.tantalar.event.mcp.call" /></Tabs.Panel>
    </Tabs>
  );
}

type IntegrationsSectionName = "overview" | "mcp";

function Integrations({
  child,
  onChildChange,
  onOpenAudit,
}: {
  readonly child?: ControlChild;
  readonly onChildChange: (child: IntegrationsSectionName) => void;
  readonly onOpenAudit: () => void;
}) {
  const requested: IntegrationsSectionName = child === "mcp" ? "mcp" : "overview";
  const [active, setActive] = useState<IntegrationsSectionName>(requested);
  useEffect(() => setActive(requested), [requested]);

  return (
    <Tabs
      value={active}
      onChange={(value) => {
        const next: IntegrationsSectionName = value === "mcp" ? "mcp" : "overview";
        setActive(next);
        onChildChange(next);
      }}
      keepMounted={false}
    >
      <Tabs.List aria-label="Integration views">
        <Tabs.Tab value="overview">API and webhooks</Tabs.Tab>
        <Tabs.Tab value="mcp">MCP</Tabs.Tab>
      </Tabs.List>
      <Tabs.Panel value="overview" pt="md">
        <IntegrationsSection isAdmin onOpenMcp={() => onChildChange("mcp")} />
      </Tabs.Panel>
      <Tabs.Panel value="mcp" pt="md">
        <McpSettings onOpenAudit={onOpenAudit} />
      </Tabs.Panel>
    </Tabs>
  );
}

type SystemSection = "health" | "appearance";

function System({
  adminId,
  child,
  onChildChange,
  onNavigate,
}: {
  readonly adminId: string | null;
  readonly child?: ControlChild;
  readonly onChildChange: (child: SystemSection) => void;
  readonly onNavigate: (area: ControlArea, child?: ControlChild) => void;
}) {
  const requested: SystemSection = child === "appearance" ? "appearance" : "health";
  const [active, setActive] = useState<SystemSection>(requested);
  useEffect(() => setActive(requested), [requested]);

  return (
    <Tabs
      value={active}
      onChange={(value) => {
        const next: SystemSection = value === "appearance" ? "appearance" : "health";
        setActive(next);
        onChildChange(next);
      }}
      keepMounted={false}
    >
      <Tabs.List aria-label="System views">
        <Tabs.Tab value="health">Health</Tabs.Tab>
        <Tabs.Tab value="appearance">Appearance</Tabs.Tab>
      </Tabs.List>
      <Tabs.Panel value="health" pt="md"><SystemHealthDashboard onNavigate={onNavigate} /></Tabs.Panel>
      <Tabs.Panel value="appearance" pt="md">
        <AppearanceSettings adminId={adminId} />
      </Tabs.Panel>
    </Tabs>
  );
}

function isAcquisitionSection(value: ControlChild | undefined): value is AcquisitionSection {
  return value === "indexers" || value === "usenet" || value === "torrent" || value === "vpn" || value === "downloads";
}

export function ControlPage({
  area,
  child,
  release,
  adminId,
  managedReleaseTarget,
  onManagedReleaseTargetChange,
  onNavigate,
}: {
  readonly area: ControlArea;
  readonly child?: ControlChild;
  readonly release?: ManagedReleaseTarget;
  readonly adminId: string | null;
  readonly managedReleaseTarget?: ManagedReleaseTarget | null;
  readonly onManagedReleaseTargetChange?: (target: ManagedReleaseTarget | null) => void;
  readonly onNavigate: (area: ControlArea, child?: ControlChild) => void;
}) {
  const metadata = CONTROL_AREAS.find((item) => item.value === area)!;
  if (release) return <ReleaseSearchPage key={`${release.kind}:${release.id}`} target={release} />;
  let content;

  switch (area) {
    case "overview":
      content = <OverviewDashboard onNavigate={onNavigate} />;
      break;
    case "media":
      content = child === "managed"
        ? (
              <ManagedTitlesControl
                releaseTarget={managedReleaseTarget}
                onReleaseTargetOpened={() => onManagedReleaseTargetChange?.(null)}
              />
            )
        : child === "libraries"
          ? <LibraryManager />
          : child === "metadata"
            ? <MetadataControl />
            : (
                <DiscoveryView
                  onOpenManagedReleases={(target) => {
                    onManagedReleaseTargetChange?.(target);
                    onNavigate("media", "managed");
                  }}
                />
              );
      break;
    case "acquisition":
      content = child === "quality" ? <QualityPage /> : (
        <AcquisitionControl
          adminId={adminId}
          activeSection={isAcquisitionSection(child) ? child : "indexers"}
          onSearchManagedReleases={(target) => {
            onManagedReleaseTargetChange?.(target);
            onNavigate("media", "managed");
          }}
          onSectionChange={(next) => onNavigate("acquisition", next)}
        />
      );
      break;
    case "integrations":
      content = (
        <Integrations
          child={child}
          onChildChange={(next) => onNavigate("integrations", next)}
          onOpenAudit={() => onNavigate("audit", "mcp")}
        />
      );
      break;
    case "jobs":
      content = <JobsPage />;
      break;
    case "extensions":
      content = <PluginsView />;
      break;
    case "people":
      content = <People />;
      break;
    case "playback":
      content = <PlaybackControl onOpenTrace={() => onNavigate("audit", "trace")} />;
      break;
    case "audit":
      content = <Audit child={child} onChildChange={(next) => onNavigate("audit", next)} />;
      break;
    case "system":
      content = child === "notifications"
        ? <NotificationsPage isAdmin />
        : <System adminId={adminId} child={child} onChildChange={(next) => onNavigate("system", next)} onNavigate={onNavigate} />;
      break;
  }

  return (
    <Stack gap="lg" data-testid={`control-page-${area}`}>
      {area === "overview" || area === "system" && child === "notifications" ? null : (
        <header className="tantalar-page-heading">
          <Title order={1}>{childrenFor(area).find((item) => item.value === (child ?? defaultControlChild(area)))?.label ?? metadata.label}</Title>
        </header>
      )}
      {content}
    </Stack>
  );
}
