/**
 * Plugin supervisor (ADR-0005, ADR-0004, ADR-0006).
 * Spawns plugin processes, performs handshake, health checks on an interval,
 * applies restart policy (exponential backoff, max-restart window), and owns
 * reversible mount/unmount. Transport: gRPC-equivalent control framing over
 * stdio pipes for Phase 1 (same message contract as the .proto service);
 * Unix-socket/loopback-TCP gRPC transport lands with the Phase 2 contract
 * freeze. Crash isolation is identical: the plugin is a separate process.
 *
 * Lifecycle states: registered → starting → healthy → degraded → restarting →
 * stopped → failed → unmounted.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { validateManifest, EventTypes, type PluginManifest } from "@tantalar/contracts";
import type { EventBus } from "./events.js";
import type { ServiceContainer, CapabilityProvider } from "./container.js";
import type { Scheduler } from "./scheduler.js";

export type PluginState =
  | "registered"
  | "starting"
  | "healthy"
  | "degraded"
  | "restarting"
  | "stopped"
  | "failed"
  | "unmounted";

export interface RestartPolicy {
  initialBackoffMs: number;
  maxBackoffMs: number;
  backoffMultiplier: number;
  windowMs: number;
  maxRestartsInWindow: number;
}

export interface PluginRuntime {
  readonly manifest: PluginManifest;
  state: PluginState;
  restartCount: number;
}

interface RunningPlugin extends PluginRuntime {
  /** Original mount config, reused across restarts. */
  config: Record<string, unknown>;
  proc: ChildProcess | null;
  unregisterFns: Array<() => void>;
  pending: Map<string, (v: unknown) => void>;
  seq: number;
  restartTimestamps: number[];
  backoffMs: number;
  restartTimer: NodeJS.Timeout | null;
  healthy: boolean;
  unmountedIntentionally: boolean;
}

export interface SupervisorOptions {
  bus: EventBus;
  container: ServiceContainer;
  scheduler: Scheduler;
  restartPolicy: RestartPolicy;
  /** Resolve the executable for a manifest entry command. */
  resolveEntry: (manifest: PluginManifest) => { command: string; args: string[]; env: Record<string, string> };
  healthIntervalMs?: number;
}

export class Supervisor {
  readonly #opts: SupervisorOptions;
  readonly #plugins = new Map<string, RunningPlugin>();
  #healthTimer: NodeJS.Timeout | null = null;

  constructor(opts: SupervisorOptions) {
    this.#opts = opts;
  }

  list(): PluginRuntime[] {
    return [...this.#plugins.values()].map((p) => ({
      manifest: p.manifest,
      state: p.state,
      restartCount: p.restartCount,
    }));
  }

  /** Test hook: the live child process for a plugin, if any. */
  testGetProc(pluginId: string): ChildProcess | null {
    return this.#plugins.get(pluginId)?.proc ?? null;
  }

  get(pluginId: string): PluginRuntime | undefined {
    const p = this.#plugins.get(pluginId);
    if (!p) return undefined;
    return { manifest: p.manifest, state: p.state, restartCount: p.restartCount };
  }

  async mount(manifestInput: unknown, config: Record<string, unknown> = {}): Promise<PluginRuntime> {
    const manifest = validateManifest(manifestInput);
    if (this.#plugins.has(manifest.id)) {
      throw new Error(`plugin already mounted: ${manifest.id}`);
    }

    // Resolve required capabilities BEFORE spawning; fail hard (ADR-0006).
    this.#opts.container.assertResolvable(manifest.requires);

    const plugin: RunningPlugin = {
      manifest,
      state: "starting",
      restartCount: 0,
      config,
      proc: null,
      unregisterFns: [],
      pending: new Map(),
      seq: 0,
      restartTimestamps: [],
      backoffMs: this.#opts.restartPolicy.initialBackoffMs,
      restartTimer: null,
      healthy: false,
      unmountedIntentionally: false,
    };
    this.#plugins.set(manifest.id, plugin);

    try {
      await this.#spawnAndStart(plugin, config);
      plugin.state = "healthy";
      plugin.healthy = true;
    } catch (err) {
      // If the process crashed during startup, hand it to the crash/restart
      // policy instead of failing the mount outright: a plugin that dies at
      // boot must still be restarted (and eventually marked failed).
      if ((err as Error).message.includes("process exited")) {
        plugin.state = "restarting";
        await this.#handleCrash(plugin, null, "startup-exit");
        return { manifest, state: plugin.state, restartCount: plugin.restartCount };
      }
      await this.#rollback(plugin);
      this.#plugins.delete(manifest.id);
      throw err;
    }

    // Reversible registration, in order; rolled back in reverse on failure.
    for (const cap of manifest.provides) {
      const provider = this.#makeProvider(plugin, cap);
      plugin.unregisterFns.push(this.#opts.container.register(provider));
    }

    await this.#opts.bus.publish({
      type: EventTypes.PluginMounted,
      producer: "core",
      subject: manifest.id,
      payload: { pluginId: manifest.id, version: manifest.version, provides: [...manifest.provides] },
    });
    this.#ensureHealthLoop();
    return plugin;
  }

  async unmount(pluginId: string): Promise<void> {
    const plugin = this.#plugins.get(pluginId);
    if (!plugin) throw new Error(`plugin not mounted: ${pluginId}`);
    plugin.unmountedIntentionally = true;
    if (plugin.restartTimer) clearTimeout(plugin.restartTimer);

    // Revoke capabilities/subscriptions first (reverse order), then stop.
    await this.#rollback(plugin);
    await this.#opts.scheduler.removeJobsFor(pluginId).catch(() => undefined);

    if (plugin.proc) {
      const proc = plugin.proc;
      plugin.proc = null;
      await new Promise<void>((resolve) => {
        const killTimer = setTimeout(() => {
          proc.kill("SIGKILL");
          resolve();
        }, 3000);
        proc.once("exit", () => {
          clearTimeout(killTimer);
          resolve();
        });
        proc.kill("SIGTERM");
      });
    }
    plugin.state = "unmounted";
    this.#plugins.delete(pluginId);

    await this.#opts.bus.publish({
      type: EventTypes.PluginUnmounted,
      producer: "core",
      subject: pluginId,
      payload: { pluginId },
    });
  }

  async stopAll(): Promise<void> {
    for (const id of [...this.#plugins.keys()]) {
      await this.unmount(id).catch(() => undefined);
    }
    if (this.#healthTimer) clearInterval(this.#healthTimer);
    this.#healthTimer = null;
  }

  // ---- internals -----------------------------------------------------------

  async #spawnAndStart(plugin: RunningPlugin, config: Record<string, unknown>): Promise<void> {
    const entry = this.#opts.resolveEntry(plugin.manifest);
    const proc = spawn(entry.command, entry.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        ...entry.env,
        TANTALAR_PLUGIN_ID: plugin.manifest.id,
        TANTALAR_PLUGIN_CONFIG: JSON.stringify(config),
      },
    });
    plugin.proc = proc;

    proc.stderr?.on("data", () => undefined); // plugin stderr is its own log
    // A child can close its control pipe before the exit event updates state.
    // Request writes handle the failure below; keep the stream error expected.
    proc.stdin?.on("error", () => undefined);

    const rl = createInterface({ input: proc.stdout! });
    rl.on("line", (line) => {
      let msg: { id?: string; op?: string; payload?: Record<string, unknown>; result?: unknown };
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.id && plugin.pending.has(msg.id)) {
        plugin.pending.get(msg.id)!(msg.result);
        plugin.pending.delete(msg.id);
        return;
      }
      // Plugin-initiated messages (emit/log/invoke).
      void this.#handlePluginMessage(plugin, msg as { op: string; payload?: Record<string, unknown> });
    });

    proc.once("exit", (code, signal) => {
      rl.close();
      // Fail any in-flight request immediately so mount/restart does not
      // block on a handshake timeout for an already-dead process.
      for (const [id, resolve] of [...plugin.pending]) {
        resolve({ __processExited: true, code, signal });
        plugin.pending.delete(id);
      }
      if (plugin.unmountedIntentionally || plugin.proc !== proc) return;
      void this.#handleCrash(plugin, code, signal);
    });

    // Handshake: protocol version check (ADR-0004).
    const ack = (await this.#request(plugin, "handshake", {}, 5000)) as {
      manifest?: unknown;
      protocolVersion?: number;
      __processExited?: boolean;
    };
    if (ack && ack.__processExited) {
      // Process died before responding; the exit handler drives the crash
      // policy. Surface a fast failure so mount() does not hang.
      throw new Error(`handshake failed for ${plugin.manifest.id}: process exited`);
    }
    if (!ack || ack.protocolVersion !== plugin.manifest.protocolVersion) {
      throw new Error(`handshake failed for ${plugin.manifest.id}: version mismatch`);
    }
    const remote = validateManifest(ack.manifest);
    if (remote.id !== plugin.manifest.id) {
      throw new Error(`handshake failed: manifest id mismatch ${remote.id}`);
    }
    await this.#request(plugin, "mount", {}, 10000);
  }

  #makeProvider(plugin: RunningPlugin, capability: string): CapabilityProvider {
    return {
      pluginId: plugin.manifest.id,
      capability,
      invoke: async (operation, payload) => {
        if (plugin.state !== "healthy" && plugin.state !== "degraded") {
          throw new Error(`capability-unavailable: ${capability} (plugin ${plugin.state})`);
        }
        const result = (await this.#request(plugin, "call", { capability, operation, payload }, 10000)) as {
          value?: unknown;
          error?: string;
        };
        if (result && typeof result === "object" && "error" in result && result.error) {
          throw new Error(String(result.error));
        }
        return result?.value;
      },
    };
  }

  async #handlePluginMessage(
    plugin: RunningPlugin,
    msg: { op: string; id?: string; payload?: Record<string, unknown> },
  ): Promise<void> {
    if (msg.op === "emit") {
      const p = msg.payload ?? {};
      try {
        await this.#opts.bus.publish({
          type: String(p.type),
          producer: plugin.manifest.id,
          payload: (p.payload as Record<string, unknown>) ?? {},
          ...(p.subject !== undefined ? { subject: String(p.subject) } : {}),
          ...(p.correlationId !== undefined ? { correlationId: String(p.correlationId) } : {}),
          ...(p.causationId !== undefined ? { causationId: String(p.causationId) } : {}),
        });
      } finally {
        if (msg.id) {
          plugin.proc?.stdin?.write(JSON.stringify({ id: msg.id, result: { ok: true } }) + "\n");
        }
      }
    } else if (msg.op === "log") {
      // Plugin logs pass through structured core logging in later phases.
      if (msg.id) {
        plugin.proc?.stdin?.write(JSON.stringify({ id: msg.id, result: { ok: true } }) + "\n");
      }
    } else if (msg.op === "introspect") {
      // Auth introspection (phase-2 contract): routed through the core
      // capability; raw keys are processed here and never logged.
      const p = msg.payload ?? {};
      let result: unknown;
      try {
        if (!plugin.manifest.requires.includes("dev.tantalar.capability.auth.introspection")) {
          throw new Error("auth introspection capability not declared in requires");
        }
        const provider = this.#opts.container.resolve("dev.tantalar.capability.auth.introspection");
        result = { value: await provider.invoke("introspect", p) };
      } catch (err) {
        result = { error: (err as Error).message };
      }
      if (msg.id) {
        plugin.proc?.stdin?.write(JSON.stringify({ id: msg.id, result }) + "\n");
      }
    } else if (msg.op === "invoke") {
      // Plugin -> capability invocation (Phase 2 surface). The plugin may
      // only call capabilities its manifest declared in `requires`; the
      // result (or error) is returned on the control channel under msg.id.
      const p = msg.payload ?? {};
      const capability = String(p.capability ?? "");
      let result: unknown;
      try {
        if (!plugin.manifest.requires.includes(capability)) {
          throw new Error(`capability ${capability} not declared in requires`);
        }
        const provider = this.#opts.container.resolve(capability);
        const value = await provider.invoke(
          String(p.operation ?? ""),
          (p.payload as Record<string, unknown>) ?? {},
        );
        result = { value };
      } catch (err) {
        result = { error: (err as Error).message };
      }
      if (msg.id) {
        plugin.proc?.stdin?.write(JSON.stringify({ id: msg.id, result }) + "\n");
      }
    }
  }

  /** Deliver an event to every healthy plugin subscribed to its type prefix. */
  async deliverEventToPlugins(envelope: unknown): Promise<void> {
    const env = envelope as { type?: string; eventId?: string };
    if (!env || typeof env.type !== "string") return;
    for (const plugin of this.#plugins.values()) {
      if (plugin.state !== "healthy" && plugin.state !== "degraded") continue;
      const matched = plugin.manifest.subscriptions.some((prefix) =>
        env.type?.startsWith(prefix),
      );
      if (!matched) continue;
      this.#request(plugin, "subscribe-delivery", { envelope }, 10000).catch(() => undefined);
    }
  }

  async #handleCrash(plugin: RunningPlugin, code: number | null, signal: string | null): Promise<void> {
    plugin.healthy = false;
    plugin.state = "restarting";
    await this.#opts.bus.publish({
      type: EventTypes.PluginCrashed,
      producer: "core",
      subject: plugin.manifest.id,
      payload: { pluginId: plugin.manifest.id, code, signal },
    });

    // Revoke capabilities while down: callers see capability-unavailable.
    await this.#rollback(plugin);

    const now = Date.now();
    plugin.restartTimestamps = plugin.restartTimestamps.filter((t) => now - t < this.#opts.restartPolicy.windowMs);
    if (plugin.restartTimestamps.length >= this.#opts.restartPolicy.maxRestartsInWindow) {
      plugin.state = "failed";
      await this.#opts.bus.publish({
        type: EventTypes.PluginFailed,
        producer: "core",
        subject: plugin.manifest.id,
        payload: { pluginId: plugin.manifest.id, restarts: plugin.restartTimestamps.length },
      });
      return;
    }

    plugin.restartTimestamps.push(now);
    plugin.restartCount++;
    const delay = Math.min(plugin.backoffMs, this.#opts.restartPolicy.maxBackoffMs);
    plugin.backoffMs = Math.min(
      plugin.backoffMs * this.#opts.restartPolicy.backoffMultiplier,
      this.#opts.restartPolicy.maxBackoffMs,
    );
    plugin.restartTimer = setTimeout(() => {
      plugin.restartTimer = null;
      void (async () => {
        try {
          plugin.state = "starting";
          await this.#spawnAndStart(plugin, plugin.config);
          plugin.state = "healthy";
          plugin.healthy = true;
          for (const cap of plugin.manifest.provides) {
            plugin.unregisterFns.push(this.#opts.container.register(this.#makeProvider(plugin, cap)));
          }
          await this.#opts.bus.publish({
            type: EventTypes.PluginRestarted,
            producer: "core",
            subject: plugin.manifest.id,
            payload: { pluginId: plugin.manifest.id, restartCount: plugin.restartCount },
          });
        } catch {
          plugin.state = "restarting";
          if (plugin.proc) {
            const proc = plugin.proc;
            plugin.proc = null;
            proc.kill("SIGKILL");
          }
          await this.#handleCrash(plugin, null, "restart-failed");
        }
      })();
    }, delay);
    plugin.restartTimer.unref?.();
  }

  /** Revoke all registration in reverse order (rollback, architecture §6). */
  async #rollback(plugin: RunningPlugin): Promise<void> {
    while (plugin.unregisterFns.length > 0) {
      const fn = plugin.unregisterFns.pop();
      try {
        fn?.();
      } catch {
        // rollback must be best-effort
      }
    }
  }

  #request(plugin: RunningPlugin, op: string, payload: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const proc = plugin.proc;
    const stdin = proc?.stdin;
    if (!proc || !stdin || stdin.destroyed || stdin.writableEnded) {
      return Promise.reject(new Error(`plugin ${plugin.manifest.id} not running`));
    }
    const id = `s${++plugin.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        plugin.pending.delete(id);
        reject(new Error(`request ${op} timed out for ${plugin.manifest.id}`));
      }, timeoutMs);
      plugin.pending.set(id, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
      stdin.write(JSON.stringify({ id, op, payload }) + "\n", (error) => {
        if (!error || !plugin.pending.has(id)) return;
        clearTimeout(timer);
        plugin.pending.delete(id);
        reject(new Error(`request ${op} failed for ${plugin.manifest.id}: ${error.message}`));
      });
    });
  }

  #ensureHealthLoop(): void {
    if (this.#healthTimer) return;
    const interval = this.#opts.healthIntervalMs ?? 5000;
    this.#healthTimer = setInterval(() => {
      for (const plugin of this.#plugins.values()) {
        if (plugin.state !== "healthy" && plugin.state !== "degraded") continue;
        void this.#request(plugin, "ping", { nonce: Math.floor(Math.random() * 1e6) }, 2000)
          .then(() => {
            plugin.healthy = true;
          })
          .catch(() => {
            plugin.state = "degraded";
          });
      }
    }, interval);
    this.#healthTimer.unref?.();
  }
}
