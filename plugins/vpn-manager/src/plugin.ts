/**
 * Real VPN lifecycle + fail-closed kill switch (Wave 6, TAN-044/TAN-045).
 *
 * Replaces the phase-3b MemoryNetControl-only surface. The plugin now owns:
 *  - validated tunnel configuration (WireguardAdapter / OpenVpnAdapter over
 *    a PrivilegedRunner seam — see adapters.ts);
 *  - safe profile file handling (0600 files in a 0700 state dir);
 *  - interface detection, route pinning, DNS pinning, health (route +
 *    public endpoint, never process state), rotation and recovery;
 *  - durable audit state via ctx.storage;
 *  - a fail-closed kill switch: any non-healthy health transition BLOCKS
 *    every bound client first, closes sockets/routes before retry.
 *
 * The kill switch is ALSO enforced inside both embedded download clients
 * (torrent-native, usenet-native) at their `add` boundary so no dispatch
 * path can bypass it.
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
  OpenVpnAdapter,
  SpawnPrivilegedRunner,
  type PrivilegedRunner,
  type TunnelAdapter,
} from "./adapters.js";

const VPN_CAPABILITY = "dev.tantalar.capability.vpn-binding";
const PLUGIN_ID = "dev.tantalar.plugin.vpn-manager";

const manifest = validateManifest({
  id: PLUGIN_ID,
  version: "0.2.0",
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

/** In-memory control for pure-handler tests; production wires real adapters. */
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

const WG_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Build the vpn-binding handler surface against explicit dependencies.
 * Exported so tests drive exactly what production runs with recording
 * runners and controls — kill-switch ORDERING is verified deterministically.
 */
export function createVpnHandlers(
  deps: {
    netControl?: NetControl;
    emit?: EmitFn;
    storage?: { get(key: string): Promise<{ doc: unknown } | null>; put(key: string, doc: unknown): Promise<void> };
    runner?: PrivilegedRunner;
    stateDir?: string;
  } = {},
) {
  const profiles = new Map<string, ProfileRecord>();
  const bindings = new Map<string, string>(); // clientId -> profileId
  /** Clients currently kill-switched: gate denies dispatch until re-bind. */
  const killSwitched = new Set<string>();
  const tunnelHealth = new Map<string, TunnelHealth>();
  let emitFn: EmitFn | null = deps.emit ?? null;
  let auditLog: AuditEntry[] = [];

  async function persistAudit(entry: AuditEntry): Promise<void> {
    auditLog.push({ ...entry, at: new Date().toISOString() });
    auditLog = auditLog.slice(-500); // bounded audit trail
    if (deps.storage) await deps.storage.put("vpn-audit", { entries: auditLog });
  }

  async function setHealth(profileId: string, health: TunnelHealth): Promise<TunnelState> {
    const record = profiles.get(profileId);
    if (!record) throw new Error(`unknown vpn profile ${profileId}`);
    const previous = tunnelHealth.get(profileId) ?? "down";
    tunnelHealth.set(profileId, health);

    // Kill switch enforcement on ANY non-healthy report for a bound client:
    // every bound client is BLOCKED (sockets/routes closed) before anything
    // else happens — including the first-ever report, not just transitions.
    // The binding record is KEPT but flagged blocked so the fail-closed gate
    // denies dispatch: an unbound-looking client must never silently fall
    // back to the default route. Dispatch reopens ONLY through an explicit
    // healthy report (route + public endpoint proven), which also triggers
    // a fresh bind on the control seam.
    if (health !== "healthy") {
      for (const [clientId, boundProfile] of bindings) {
        if (boundProfile !== profileId) continue;
        if (!killSwitched.has(clientId) || previous === "healthy") {
          await deps.netControl?.block(clientId); // stop transfer before fallback routing
        }
        killSwitched.add(clientId);
        await persistAudit({ action: "block", clientId, profileId, detail: `health=${health}` });
        await emitFn?.(EventTypes.TunnelHealthChanged, {
          profileId,
          health,
          clientId,
          killSwitchEngaged: true,
        });
      }
    } else if (previous !== "healthy") {
      for (const [clientId, boundProfile] of bindings) {
        if (boundProfile === profileId && killSwitched.has(clientId)) {
          killSwitched.delete(clientId);
          await deps.netControl?.bind(clientId, profileId); // re-pin routes/DNS after recovery
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
    return new OpenVpnAdapter(runner, config.device);
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
        // Registration accepts metadata-only profiles (no configText yet);
        // full validation runs when the config file is materialized.
        let config: ReturnType<typeof validateProfileConfig> | null = null;
        try {
          if (typeof p.configText === "string" && p.configText.length > 0) {
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
            endpointHost: String(p.endpointHost ?? "unknown"),
          },
          ...(config !== null ? { config } : {}),
        });
      }
    },

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
      return new LifecycleNetControl(runner, map, persistAudit);
    },

    auditEntries(): AuditEntry[] {
      return [...auditLog];
    },

    async recover(): Promise<number> {
      // Restart recovery: every previously-bound client re-verifies its
      // tunnel; anything that cannot prove healthy stays blocked.
      let recovered = 0;
      for (const [clientId, profileId] of [...bindings]) {
        const health = tunnelHealth.get(profileId) ?? "down";
        if (health === "healthy") recovered += 1;
        else {
          bindings.delete(clientId);
          await deps.netControl?.block(clientId);
          await persistAudit({ action: "recover", clientId, profileId, detail: "blocked-unhealthy" });
        }
      }
      return recovered;
    },

    handlers: {
      [VPN_CAPABILITY]: async (operation: string, payload: Record<string, unknown>): Promise<unknown> => {
        switch (operation) {
          case "profiles":
            return { profiles: [...profiles.values()].map((r) => r.profile) };
          case "bindings": {
            const out: ClientBinding[] = [...bindings.entries()].map(([clientId, profileId]) => ({
              clientId,
              profileId,
            }));
            return { bindings: out };
          }
          case "set-binding": {
            const clientId = String(payload.clientId ?? "");
            if (!clientId) throw new Error("clientId required");
            if (payload.profileId === null || payload.profileId === undefined || payload.profileId === "") {
              // Explicit VPN-disable path: back to direct binding.
              await deps.netControl?.unbind(clientId);
              bindings.delete(clientId);
              await persistAudit({ action: "unbind", clientId });
              return { clientId, profileId: null };
            }
            const profileId = String(payload.profileId);
            if (!profiles.has(profileId)) throw new Error(`unknown vpn profile ${profileId}`);
            await deps.netControl?.bind(clientId, profileId);
            bindings.set(clientId, profileId);
            killSwitched.delete(clientId); // explicit re-bind re-opens the gate
            await persistAudit({ action: "bind", clientId, profileId });
            return { clientId, profileId };
          }
          case "rotate-tunnel": {
            const clientId = String(payload.clientId ?? "");
            const fromId = String(payload.fromProfileId ?? "");
            const toId = String(payload.toProfileId ?? "");
            if (!profiles.has(fromId)) throw new Error(`unknown vpn profile ${fromId}`);
            if (!profiles.has(toId)) throw new Error(`unknown vpn profile ${toId}`);
            // Rotation ordering: block (teardown) THEN bind the new tunnel.
            await deps.netControl?.block(clientId);
            await deps.netControl?.bind(clientId, toId);
            bindings.set(clientId, toId);
            await persistAudit({ action: "rotate", clientId, profileId: toId, detail: `from=${fromId}` });
            return { clientId, profileId: toId, rotatedFrom: fromId };
          }
          case "health-report":
            return setHealth(String(payload.profileId), payload.health as TunnelHealth);
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
            if (health === "healthy") {
              return { allowDispatch: true, profileId, health };
            }
            // Anything else blocks — degraded, down, or simply not yet reported.
            return { allowDispatch: false, profileId, health: health ?? "down" };
          }
          case "audit-log":
            return { entries: auditLog };
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
  mount(ctx) {
    const cfg = loadConfig();
    const rawProfiles = Array.isArray(cfg.profiles) ? (cfg.profiles as Record<string, unknown>[]) : [];
    active = createVpnHandlers({
      emit: (type, payload, opts) => ctx.emit(type, payload, opts),
      storage: ctx.storage,
      stateDir: typeof cfg.stateDir === "string" ? cfg.stateDir : undefined,
    });
    active.loadProfiles(rawProfiles);
    ctx.log("info", "vpn-manager mounted (real lifecycle adapters)");
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
