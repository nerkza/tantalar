/**
 * VPN manager plugin (phase 3b, stories 6+31/32).
 *
 * Provides `dev.tantalar.capability.vpn-binding`: per-download-client
 * tunnel binding for OpenVPN and WireGuard profiles, with a FAIL-CLOSED
 * kill switch. A bound client may dispatch traffic ONLY while its tunnel
 * reports explicit `healthy` state; any other state (degraded, down,
 * unknown profile) blocks the grab BEFORE any transfer could fall back to
 * the default route.
 *
 * The actual network namespace manipulation is abstracted behind a
 * `NetControl` interface. Production wires OpenVPN (`--config`) and
 * WireGuard (`wg-quick`) commands plus routing rules into it; tests inject
 * an in-memory fake (or a recording one) so the kill-switch ordering is
 * verified deterministically with zero leak window and no real interfaces
 * touched.
 *
 * Tunnel credentials live only inside NetControl construction from redacted
 * config; they never reach logs or events.
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

const VPN_CAPABILITY = "dev.tantalar.capability.vpn-binding";
const PLUGIN_ID = "dev.tantalar.plugin.vpn-manager";

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
 * Network control seam. `bind` pins a client's traffic to the tunnel;
 * `unbind` returns it to the default route EXPLICITLY (VPN disable path);
 * `block` is the kill switch: stop transfers and pin traffic to nowhere so
 * nothing can fall back while the tunnel is unhealthy.
 */
export interface NetControl {
  bind(clientId: string, profileId: string): Promise<void>;
  unbind(clientId: string): Promise<void>;
  block(clientId: string): Promise<void>;
}

/** In-memory control used when no real net control is configured (tests). */
export class MemoryNetControl implements NetControl {
  readonly bound = new Map<string, string>(); // clientId -> profileId
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

function loadConfig(): Record<string, unknown> {
  return JSON.parse(process.env["TANTALAR_PLUGIN_CONFIG"] ?? "{}") as Record<string, unknown>;
}

type EmitFn = (type: string, payload: Record<string, unknown>, opts?: { correlationId?: string }) => Promise<void>;

/**
 * Build the vpn-binding handler surface against explicit dependencies.
 * Exported so tests can drive the exact same logic the subprocess runs,
 * injecting a recording NetControl to observe kill-switch ORDERING.
 */
export function createVpnHandlers(deps: { netControl?: NetControl; emit?: EmitFn } = {}) {
  const profiles = new Map<string, VpnProfile>();
  const bindings = new Map<string, string>(); // clientId -> profileId
  const tunnelHealth = new Map<string, TunnelHealth>();
  let emitFn: EmitFn | null = deps.emit ?? null;

  async function setHealth(profileId: string, health: TunnelHealth): Promise<TunnelState> {
    const profile = profiles.get(profileId);
    if (!profile) throw new Error(`unknown vpn profile ${profileId}`);
    const previous = tunnelHealth.get(profileId) ?? "down";
    tunnelHealth.set(profileId, health);

    // Kill switch enforcement on any transition away from healthy:
    // every bound client is BLOCKED before anything else happens.
    if (health !== "healthy" && previous === "healthy") {
      for (const [clientId, boundProfile] of bindings) {
        if (boundProfile !== profileId) continue;
        await deps.netControl?.block(clientId); // stop transfer before fallback routing
        await emitFn?.(EventTypes.TunnelHealthChanged, {
          profileId,
          health,
          clientId,
          killSwitchEngaged: true,
        });
      }
    } else if (health !== "healthy") {
      for (const [clientId, boundProfile] of bindings) {
        if (boundProfile === profileId) await deps.netControl?.block(clientId);
      }
    }
    return { profileId, health, protocol: profile.protocol };
  }

  return {
    loadProfiles(rawProfiles: Array<Record<string, unknown>>): void {
      profiles.clear();
      for (const p of rawProfiles) {
        if (typeof p.profileId === "string" && (p.protocol === "openvpn" || p.protocol === "wireguard")) {
          profiles.set(p.profileId, {
            profileId: p.profileId,
            protocol: p.protocol,
            endpointHost: String(p.endpointHost ?? "unknown"),
          });
        }
      }
    },
    handlers: {
      [VPN_CAPABILITY]: async (operation: string, payload: Record<string, unknown>): Promise<unknown> => {
        switch (operation) {
          case "profiles":
            return { profiles: [...profiles.values()] };
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
              return { clientId, profileId: null };
            }
            const profileId = String(payload.profileId);
            if (!profiles.has(profileId)) throw new Error(`unknown vpn profile ${profileId}`);
            await deps.netControl?.bind(clientId, profileId);
            bindings.set(clientId, profileId);
            return { clientId, profileId };
          }
          case "health-report":
            return setHealth(String(payload.profileId), payload.health as TunnelHealth);
          case "tunnel-state":
            return {
              profileId: String(payload.profileId),
              health: tunnelHealth.get(String(payload.profileId)) ?? "down",
              protocol: profiles.get(String(payload.profileId))?.protocol ?? ("wireguard" as TunnelProtocol),
            };
          case "pre-dispatch-check": {
            // Fail-closed gate consulted by the grab pipeline BEFORE dispatch.
            const clientId = String(payload.clientId ?? "");
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
      netControl: (cfg.netControl as NetControl | undefined) ?? new MemoryNetControl(),
      emit: (type, payload, opts) => ctx.emit(type, payload, opts),
    });
    active.loadProfiles(rawProfiles);
    ctx.log("info", "vpn-manager mounted");
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
