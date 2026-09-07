/**
 * VPN policy, lifecycle seams and fail-closed dispatch gate.
 *
 * The plugin owns strict WireGuard validation, safe 0600/0700 profile-file
 * materialization, durable redacted policy intent, trusted host preflight and
 * a fail-closed logical gate. Adapter seams exist for later Linux-boundary
 * work, but normal boot does not claim route, DNS or leak enforcement.
 *
 * This package does not claim a complete network kill switch. Apply stays
 * unavailable in normal boot until a trusted Linux boundary is wired.
 */
import { runPlugin, definePlugin, type PluginDefinition } from "@tantalar/plugin-sdk";
import {
  PROTOCOL_VERSION,
  validateManifest,
  EventTypes,
  type ClientBinding,
  type TunnelHealth,
  type TunnelProtocol,
  type TunnelState,
  type VpnProfile,
} from "@tantalar/contracts";
import {
  validateProfileConfig,
  writeProfileFile,
  WireguardAdapter,
  SpawnPrivilegedRunner,
  inspectWireguardHost,
  type PrivilegedRunner,
  type TunnelAdapter,
  type WireguardHostPreflight,
} from "./adapters.js";

const VPN_CAPABILITY = "dev.tantalar.capability.vpn-binding";
const PLUGIN_ID = "dev.tantalar.plugin.vpn-manager";
const STATE_KEY = "vpn-state-v1";
const AUDIT_KEY = "vpn-audit";

const manifest = validateManifest({
  id: PLUGIN_ID,
  version: "0.1.0",
  protocolVersion: PROTOCOL_VERSION,
  provides: [VPN_CAPABILITY],
  requires: ["dev.tantalar.capability.event.emit", "dev.tantalar.capability.log"],
  subscriptions: [],
  entry: { command: "node dist/plugin.js" },
});

/**
 * Network control seam retained for the kill-switch ordering contract:
 * bind pins traffic to the tunnel's approved interface only; unbind
 * returns explicitly to direct; block tears routes/sockets down FIRST so
 * nothing can fall back while unhealthy.
 */
export interface NetControl {
  bind(clientId: string, profileId: string): Promise<void>;
  unbind(clientId: string): Promise<void>;
  block(clientId: string): Promise<void>;
}

/** In-memory control for pure-handler tests. */
export class MemoryNetControl implements NetControl {
  readonly bound = new Map<string, string>();
  readonly blocked = new Set<string>();
  async bind(clientId: string, profileId: string): Promise<void> {
    this.blocked.delete(clientId);
    this.bound.set(clientId, profileId);
  }
  async unbind(clientId: string): Promise<void> {
    this.blocked.delete(clientId);
    this.bound.delete(clientId);
  }
  /** Kill switch ordering: block FIRST, then drop the binding. */
  async block(clientId: string): Promise<void> {
    this.blocked.add(clientId);
    this.bound.delete(clientId);
  }
}

/**
 * Real NetControl driving the tunnel lifecycle adapters. Every mutation
 * records an audit entry through the injected sink. Rotation stops the old
 * tunnel BEFORE starting the new one. Recovery re-checks health on mount
 * and blocks everything when the tunnel did not survive.
 */
export class LifecycleNetControl implements NetControl {
  readonly blocked = new Set<string>();
  private readonly bound = new Map<string, string>(); // clientId -> profileId
  private currentProfilePath: string | null = null;

  constructor(
    private readonly runner: PrivilegedRunner,
    private readonly profiles: Map<string, { config: ReturnType<typeof validateProfileConfig>; adapter: TunnelAdapter; path: string | null }>,
    private readonly audit: (entry: AuditEntry) => Promise<void>,
  ) {}

  async ensureProfileUp(profileId: string): Promise<void> {
    const p = this.profiles.get(profileId);
    if (!p) throw new Error(`unknown vpn profile ${profileId}`);
    if (!p.path) throw new Error(`profile ${profileId} has no written config file`);
    // Rotation: tear down whatever is up before bringing this one up.
    if (this.currentProfilePath && this.currentProfilePath !== p.path) await this.teardownCurrent();
    const iface = await p.adapter.detectInterface();
    if (!iface) await p.adapter.up(p.path);
    else if ((await p.adapter.checkHealth(iface)) === "down") {
      await p.adapter.down(p.path); // route loss closes sockets before retry
      await p.adapter.up(p.path);
    }
    this.currentProfilePath = p.path;
    await this.audit({ action: "tunnel-up", profileId });
  }

  private async teardownCurrent(): Promise<void> {
    if (!this.currentProfilePath) return;
    for (const [, p] of this.profiles) {
      if (p.path === this.currentProfilePath) {
        await p.adapter.down(p.path).catch(() => undefined);
        break;
      }
    }
    this.currentProfilePath = null;
  }

  async bind(clientId: string, profileId: string): Promise<void> {
    await this.ensureProfileUp(profileId);
    this.blocked.delete(clientId);
    this.bound.set(clientId, profileId);
    await this.audit({ action: "bind", clientId, profileId });
  }

  async unbind(clientId: string): Promise<void> {
    this.blocked.delete(clientId);
    this.bound.delete(clientId);
    await this.audit({ action: "unbind", clientId });
  }

  /** Kill switch: block the client FIRST, then tear the tunnel down. */
  async block(clientId: string): Promise<void> {
    const profileId = this.bound.get(clientId);
    this.blocked.add(clientId);
    this.bound.delete(clientId);
    await this.teardownCurrent();
    await this.audit({ action: "block", clientId, ...(profileId ? { profileId } : {}) });
  }
}

export interface AuditEntry {
  readonly at?: string;
  readonly action: "bind" | "unbind" | "block" | "health" | "tunnel-up" | "rotate" | "recover";
  readonly clientId?: string;
  readonly profileId?: string;
  readonly detail?: string;
}

function loadConfig(): Record<string, unknown> {
  return JSON.parse(process.env["TANTALAR_PLUGIN_CONFIG"] ?? "{}") as Record<string, unknown>;
}

type EmitFn = (type: string, payload: Record<string, unknown>, opts?: { correlationId?: string }) => Promise<void>;

interface ProfileRecord {
  profile: VpnProfile;
  /** Present once a full configText was provided and validated. */
  config?: ReturnType<typeof validateProfileConfig>;
}

interface PluginStorage {
  get(key: string): Promise<{ doc: unknown } | null>;
  put(key: string, doc: unknown): Promise<void>;
}

interface DurableVpnState {
  readonly version: 1;
  /** Metadata only. Tunnel configuration and credentials are never stored here. */
  readonly profiles: readonly VpnProfile[];
  readonly bindings: readonly ClientBinding[];
}

const WG_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const CLIENT_ID_RE = /^[a-zA-Z0-9._-]{1,160}$/;
const AUDIT_ACTIONS = new Set<AuditEntry["action"]>(["bind", "unbind", "block", "health", "tunnel-up", "rotate", "recover"]);

function safeEndpointHost(value: unknown): string {
  const host = typeof value === "string" ? value.trim() : "";
  if (host.length === 0 || host.length > 253 || /[@/?#\s]/.test(host)) return "unknown";
  if (/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host)) return host;
  if (/^[0-9a-fA-F:]+$/.test(host)) return host;
  return "unknown";
}

/**
 * Build the vpn-binding handler surface against explicit dependencies.
 * Exported so tests drive exactly what production runs with recording
 * runners and controls — kill-switch ORDERING is verified deterministically.
 */
export function createVpnHandlers(
  deps: {
    netControl?: NetControl;
    emit?: EmitFn;
    storage?: PluginStorage;
    runner?: PrivilegedRunner;
    stateDir?: string;
    platform?: string;
  } = {},
) {
  const profiles = new Map<string, ProfileRecord>();
  const bindings = new Map<string, string>(); // clientId -> profileId
  /** Clients currently kill-switched: gate denies dispatch until re-bind. */
  const killSwitched = new Set<string>();
  const tunnelHealth = new Map<string, TunnelHealth>();
  let emitFn: EmitFn | null = deps.emit ?? null;
  let auditLog: AuditEntry[] = [];
  let lastPreflight: WireguardHostPreflight | null = null;

  const profileSummaries = (): VpnProfile[] => [...profiles.values()].map((record) => ({ ...record.profile }));

  async function persistState(): Promise<void> {
    if (!deps.storage) return;
    const durable: DurableVpnState = {
      version: 1,
      profiles: profileSummaries(),
      bindings: [...bindings.entries()].map(([clientId, profileId]) => ({ clientId, profileId })),
    };
    await deps.storage.put(STATE_KEY, durable);
  }

  async function persistAudit(entry: AuditEntry): Promise<void> {
    auditLog.push({ ...entry, at: new Date().toISOString() });
    auditLog = auditLog.slice(-500); // bounded audit trail
    if (deps.storage) await deps.storage.put(AUDIT_KEY, { entries: auditLog });
  }

  async function restore(): Promise<void> {
    if (!deps.storage) return;
    const [stateHit, auditHit] = await Promise.all([
      deps.storage.get(STATE_KEY),
      deps.storage.get(AUDIT_KEY),
    ]);

    const savedAudit = (auditHit?.doc as { entries?: unknown } | undefined)?.entries;
    if (Array.isArray(savedAudit)) {
      auditLog = savedAudit
        .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object"
          && AUDIT_ACTIONS.has((entry as Record<string, unknown>)["action"] as AuditEntry["action"]))
        .slice(-500)
        .map((entry) => ({
          action: entry["action"] as AuditEntry["action"],
          ...(typeof entry["at"] === "string" ? { at: entry["at"] } : {}),
          ...(typeof entry["clientId"] === "string" && CLIENT_ID_RE.test(entry["clientId"])
            ? { clientId: entry["clientId"] } : {}),
          ...(typeof entry["profileId"] === "string" && WG_ID_RE.test(entry["profileId"])
            ? { profileId: entry["profileId"] } : {}),
          ...(typeof entry["detail"] === "string" && entry["detail"].length <= 160
            ? { detail: entry["detail"] } : {}),
        }));
    }

    const saved = stateHit?.doc as Partial<DurableVpnState> | undefined;
    if (saved?.version !== 1) return;
    if (Array.isArray(saved.profiles)) {
      for (const profile of saved.profiles) {
        if (!profile || typeof profile !== "object") continue;
        const profileId = String(profile.profileId ?? "");
        if (!WG_ID_RE.test(profileId)) continue;
        if (profile.protocol !== "wireguard" && profile.protocol !== "openvpn") continue;
        if (!profiles.has(profileId)) {
          profiles.set(profileId, {
            profile: {
              profileId,
              protocol: profile.protocol,
              endpointHost: safeEndpointHost(profile.endpointHost),
            },
          });
        }
      }
    }

    bindings.clear();
    killSwitched.clear();
    if (Array.isArray(saved.bindings)) {
      for (const binding of saved.bindings) {
        if (!binding || typeof binding !== "object") continue;
        const clientId = typeof binding.clientId === "string" ? binding.clientId : "";
        const profileId = typeof binding.profileId === "string" ? binding.profileId : "";
        if (!CLIENT_ID_RE.test(clientId) || !WG_ID_RE.test(profileId)) continue;
        bindings.set(clientId, profileId);
        killSwitched.add(clientId);
        tunnelHealth.set(profileId, "down");
        await deps.netControl?.block(clientId);
      }
    }
  }

  async function preflight(): Promise<WireguardHostPreflight> {
    const runner = deps.runner ?? new SpawnPrivilegedRunner();
    lastPreflight = await inspectWireguardHost(runner, deps.platform ?? process.platform);
    return lastPreflight;
  }

  async function setHealth(profileId: string, health: TunnelHealth): Promise<TunnelState> {
    const record = profiles.get(profileId);
    if (!record) throw new Error(`unknown vpn profile ${profileId}`);
    if (health !== "healthy" && health !== "degraded" && health !== "down") {
      throw new Error(`invalid tunnel health ${JSON.stringify(health)}`);
    }
    const previous = tunnelHealth.get(profileId) ?? "down";

    if (health !== "healthy") {
      tunnelHealth.set(profileId, health);
      for (const [clientId, boundProfile] of bindings) {
        if (boundProfile !== profileId) continue;
        await deps.netControl?.block(clientId);
        killSwitched.add(clientId);
        await persistAudit({ action: "block", clientId, profileId, detail: `health=${health}` });
        await emitFn?.(EventTypes.TunnelHealthChanged, {
          profileId,
          health,
          clientId,
          killSwitchEngaged: true,
        });
      }
    } else {
      // Health can only reopen a binding when trusted lifecycle control exists.
      // Bind first; publish healthy and clear the logical block only after every
      // required network mutation succeeds.
      if (!deps.netControl) throw new Error("vpn lifecycle control unavailable; tunnel remains blocked");
      for (const [clientId, boundProfile] of bindings) {
        if (boundProfile === profileId && (killSwitched.has(clientId) || previous !== "healthy")) {
          await deps.netControl.bind(clientId, profileId);
        }
      }
      tunnelHealth.set(profileId, "healthy");
      for (const [clientId, boundProfile] of bindings) {
        if (boundProfile === profileId && killSwitched.has(clientId)) {
          killSwitched.delete(clientId);
          await persistAudit({ action: "bind", clientId, profileId, detail: "recovered" });
        }
      }
    }
    if (previous !== health) {
      await persistAudit({ action: "health", profileId, detail: `${previous}->${health}` });
      await emitFn?.(EventTypes.TunnelHealthChanged, { profileId, health, previous });
    }
    return { profileId, health, protocol: record.profile.protocol };
  }

  function buildAdapter(record: ProfileRecord): TunnelAdapter {
    const runner = deps.runner ?? new SpawnPrivilegedRunner();
    const config = record.config;
    if (!config) throw new Error(`profile ${record.profile.profileId} has no validated config yet`);
    if (config.protocol === "wireguard") {
      return new WireguardAdapter(runner, record.profile.profileId);
    }
    throw new Error("openvpn apply is disabled in this build");
  }

  return {
    loadProfiles(rawProfiles: Array<Record<string, unknown>>): void {
      profiles.clear();
      for (const p of rawProfiles) {
        const profileId = String(p.profileId ?? "");
        const protocol = p.protocol;
        if (typeof profileId !== "string" || !WG_ID_RE.test(profileId)) {
          void emitFn?.(EventTypes.TunnelHealthChanged, { profileId, health: "down", configRejected: true }).catch(() => undefined);
          continue;
        }
        if (protocol !== "openvpn" && protocol !== "wireguard") {
          void emitFn?.(EventTypes.TunnelHealthChanged, { profileId, health: "down", configRejected: true }).catch(() => undefined);
          continue;
        }
        // Registration accepts metadata-only profiles. WireGuard configuration
        // is validated now, before it can touch disk. OpenVPN stays metadata-only.
        let config: ReturnType<typeof validateProfileConfig> | null = null;
        try {
          if (protocol === "wireguard" && typeof p.configText === "string" && p.configText.length > 0) {
            config = validateProfileConfig(p);
          }
        } catch {
          void emitFn?.(EventTypes.TunnelHealthChanged, { profileId, health: "down", configRejected: true }).catch(() => undefined);
          continue;
        }
        profiles.set(profileId, {
          profile: {
            profileId,
            protocol,
            endpointHost: safeEndpointHost(p.endpointHost),
          },
          ...(config !== null ? { config } : {}),
        });
        if (protocol === "openvpn" && typeof p.configText === "string" && p.configText.length > 0) {
          void emitFn?.(EventTypes.TunnelHealthChanged, {
            profileId,
            health: "down",
            applyDisabled: true,
          }).catch(() => undefined);
        }
      }
    },

    loadBindings(rawBindings: Array<Record<string, unknown>>): void {
      bindings.clear();
      killSwitched.clear();
      for (const raw of rawBindings) {
        const clientId = typeof raw.clientId === "string" ? raw.clientId.trim() : "";
        const profileId = typeof raw.profileId === "string" ? raw.profileId.trim() : "";
        if (!CLIENT_ID_RE.test(clientId) || !WG_ID_RE.test(profileId)) continue;
        bindings.set(clientId, profileId);
        killSwitched.add(clientId);
        tunnelHealth.set(profileId, "down");
      }
    },

    restore,

    persist: persistState,

    trustedHealthReport(profileId: string, health: TunnelHealth): Promise<TunnelState> {
      return setHealth(profileId, health);
    },

    preflight,

    /** Write profile configs safely (0600) into the managed state dir. */
    materializeProfiles(): Record<string, string> {
      const dir = deps.stateDir ?? "/var/lib/tantalar/vpn";
      const out: Record<string, string> = {};
      for (const [id, rec] of profiles) {
        if (!rec.config) continue; // metadata-only registration
        out[id] = writeProfileFile(dir, rec.config);
      }
      return out;
    },

    buildLifecycleControl(): LifecycleNetControl {
      const runner = deps.runner ?? new SpawnPrivilegedRunner();
      const map = new Map<string, { config: ReturnType<typeof validateProfileConfig>; adapter: TunnelAdapter; path: string | null }>();
      const dir = deps.stateDir ?? "/var/lib/tantalar/vpn";
      for (const [profileId, record] of profiles) {
        if (!record.config) continue;
        map.set(profileId, {
          config: record.config,
          adapter: buildAdapter(record),
          path: writeProfileFile(dir, record.config),
        });
      }
      return new LifecycleNetControl(runner, map, persistAudit);
    },

    auditEntries(): AuditEntry[] {
      return [...auditLog];
    },

    async recover(): Promise<number> {
      // Restart recovery never deletes desired binding intent. Deleting it
      // would make pre-dispatch treat the client as explicitly direct.
      let recovered = 0;
      for (const [clientId, profileId] of [...bindings]) {
        const health = tunnelHealth.get(profileId) ?? "down";
        if (health === "healthy" && deps.netControl) recovered += 1;
        else {
          await deps.netControl?.block(clientId);
          killSwitched.add(clientId);
          await persistAudit({ action: "recover", clientId, profileId, detail: "blocked-unhealthy" });
        }
      }
      await persistState();
      return recovered;
    },

    handlers: {
      [VPN_CAPABILITY]: async (operation: string, payload: Record<string, unknown>): Promise<unknown> => {
        switch (operation) {
          case "profiles":
            return { profiles: profileSummaries() };
          case "preflight": {
            const host = await preflight();
            return {
              ...host,
              lifecycleControlReady: Boolean(deps.netControl),
              enforcementReady: host.supported && Boolean(deps.netControl),
            };
          }
          case "status": {
            const host = await preflight();
            return {
              host,
              lifecycleControlReady: Boolean(deps.netControl),
              enforcementReady: host.supported && Boolean(deps.netControl),
              openvpnApplySupported: false,
              profiles: [...profiles.values()].map((record) => ({
                ...record.profile,
                configured: Boolean(record.config),
                applySupported: record.profile.protocol === "wireguard" && Boolean(record.config)
                  && host.supported && Boolean(deps.netControl),
              })),
              bindings: [...bindings.entries()].map(([clientId, profileId]) => ({
                clientId,
                profileId,
                blocked: killSwitched.has(clientId) || tunnelHealth.get(profileId) !== "healthy" || !deps.netControl,
              })),
              checkedAt: lastPreflight?.checkedAt ?? host.checkedAt,
            };
          }
          case "bindings": {
            const out: ClientBinding[] = [...bindings.entries()].map(([clientId, profileId]) => ({
              clientId,
              profileId,
            }));
            return { bindings: out };
          }
          case "set-binding": {
            const clientId = String(payload.clientId ?? "");
            if (!CLIENT_ID_RE.test(clientId)) throw new Error("valid clientId required");
            if (payload.profileId === null || payload.profileId === undefined || payload.profileId === "") {
              // Explicit VPN-disable path: back to direct binding.
              await deps.netControl?.unbind(clientId);
              bindings.delete(clientId);
              killSwitched.delete(clientId);
              await persistState();
              await persistAudit({ action: "unbind", clientId });
              return { clientId, profileId: null };
            }
            const profileId = String(payload.profileId);
            const record = profiles.get(profileId);
            if (!record) throw new Error(`unknown vpn profile ${profileId}`);
            if (record.profile.protocol !== "wireguard") throw new Error("openvpn apply is disabled in this build");
            bindings.set(clientId, profileId);
            killSwitched.add(clientId);
            tunnelHealth.set(profileId, "down");
            await persistState();
            if (!deps.netControl) {
              await persistAudit({ action: "block", clientId, profileId, detail: "lifecycle-control-unavailable" });
              return { clientId, profileId, applied: false, blocked: true, reason: "lifecycle-control-unavailable" };
            }
            await deps.netControl.bind(clientId, profileId);
            await persistAudit({ action: "bind", clientId, profileId, detail: "awaiting-trusted-health" });
            return { clientId, profileId, applied: true, blocked: true, reason: "awaiting-trusted-health" };
          }
          case "rotate-tunnel": {
            const clientId = String(payload.clientId ?? "");
            if (!CLIENT_ID_RE.test(clientId)) throw new Error("valid clientId required");
            const fromId = String(payload.fromProfileId ?? "");
            const toId = String(payload.toProfileId ?? "");
            if (!profiles.has(fromId)) throw new Error(`unknown vpn profile ${fromId}`);
            const target = profiles.get(toId);
            if (!target) throw new Error(`unknown vpn profile ${toId}`);
            if (target.profile.protocol !== "wireguard") throw new Error("openvpn apply is disabled in this build");
            if (!deps.netControl) throw new Error("vpn lifecycle control unavailable; tunnel remains blocked");
            // Rotation ordering: block (teardown) THEN bind the new tunnel.
            killSwitched.add(clientId);
            await deps.netControl.block(clientId);
            await deps.netControl.bind(clientId, toId);
            bindings.set(clientId, toId);
            tunnelHealth.set(toId, "down");
            await persistState();
            await persistAudit({ action: "rotate", clientId, profileId: toId, detail: `from=${fromId}` });
            return { clientId, profileId: toId, rotatedFrom: fromId, blocked: true, reason: "awaiting-trusted-health" };
          }
          case "health-report":
            throw new Error("health-report is runtime-internal and cannot be submitted by a client");
          case "tunnel-state":
            return {
              profileId: String(payload.profileId),
              health: tunnelHealth.get(String(payload.profileId)) ?? "down",
              protocol: profiles.get(String(payload.profileId))?.profile.protocol ?? ("wireguard" as TunnelProtocol),
            };
          case "pre-dispatch-check": {
            // Fail-closed gate consulted by the grab pipeline BEFORE dispatch.
            const clientId = String(payload.clientId ?? "");
            if (killSwitched.has(clientId)) {
              return { allowDispatch: false, profileId: bindings.get(clientId) ?? null, health: "down" };
            }
            const profileId = bindings.get(clientId);
            if (!profileId) {
              // Unbound clients are direct; allowed.
              return { allowDispatch: true, profileId: null, health: null };
            }
            const health = tunnelHealth.get(profileId);
            if (health === "healthy" && deps.netControl) {
              return { allowDispatch: true, profileId, health };
            }
            // Anything else blocks — degraded, down, or simply not yet reported.
            return { allowDispatch: false, profileId, health: health ?? "down" };
          }
          case "audit-log":
            return { entries: auditLog.map((entry) => ({ ...entry })) };
          case "conformance-probe":
            return { ok: true };
          default:
            throw new Error(`unknown operation ${operation}`);
        }
      },
    },
  };
}

let active = createVpnHandlers();

const plugin: PluginDefinition = definePlugin({
  manifest,
  async mount(ctx) {
    const cfg = loadConfig();
    const rawProfiles = Array.isArray(cfg.profiles) ? (cfg.profiles as Record<string, unknown>[]) : [];
    const rawBindings = Array.isArray(cfg.bindings) ? (cfg.bindings as Record<string, unknown>[]) : [];
    active = createVpnHandlers({
      emit: (type, payload, opts) => ctx.emit(type, payload, opts),
      storage: ctx.storage,
      stateDir: typeof cfg.stateDir === "string" ? cfg.stateDir : undefined,
    });
    active.loadProfiles(rawProfiles);
    active.loadBindings(rawBindings);
    await active.restore();
    await active.recover();
    await active.persist();
    ctx.log("info", "vpn-manager mounted (policy restored; enforcement requires trusted lifecycle control)");
  },
  unmount(ctx) {
    ctx.log("info", "vpn-manager unmounted");
  },
  handlers: {
    // Delegates to whichever handler surface the last mount built.
    get [VPN_CAPABILITY]() {
      return active.handlers[VPN_CAPABILITY];
    },
  },
});

runPlugin(plugin);
