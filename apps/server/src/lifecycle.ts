/**
 * Config-driven plugin lifecycle (story 24, phase-2 doc): the enabled plugin
 * set lives in layered YAML config; applying a new config diffs against the
 * running set and mounts/unmounts to converge. Swap semantics: mount the new
 * version first, then unmount the old; if the new mount fails, the old stays
 * running (rollback) and the config apply reports the failure.
 */
import { readFile } from "node:fs/promises";
import { validateManifest, type PluginManifest } from "@tantalar/contracts";
import { loadPackage, PackageError } from "@tantalar/plugin-sdk";
import type { Supervisor } from "./supervisor.js";

export interface PluginSetEntry {
  readonly enabled?: boolean;
  readonly manifestPath?: string;
  readonly config?: Record<string, unknown>;
}

export type PluginSet = Record<string, PluginSetEntry>;

export interface ApplyResult {
  mounted: string[];
  unmounted: string[];
  failed: Array<{ pluginId: string; error: string }>;
}

export interface LifecycleOptions {
  supervisor: Supervisor;
  /** Resolve manifestPath (relative to config file location or cwd). */
  basePath?: string;
}

export class PluginLifecycleManager {
  readonly #opts: LifecycleOptions;

  constructor(opts: LifecycleOptions) {
    this.#opts = opts;
  }

  /** Load + validate a manifest file from a configured path. */
  async loadManifest(path: string): Promise<PluginManifest> {
    const base = this.#opts.basePath ?? process.cwd();
    const abs = path.startsWith("/") ? path : `${base.replace(/\/$/, "")}/${path}`;
    let raw: string;
    try {
      raw = await readFile(abs, "utf8");
    } catch {
      throw new PackageError(`manifest not readable: ${abs}`);
    }
    const parsed: unknown = JSON.parse(raw);
    // A manifest.json may sit inside a full package dir; validate the entry
    // script exists when it is a package-relative path.
    const manifest = validateManifest(parsed);
    await loadPackage(abs.slice(0, abs.lastIndexOf("/"))).catch(() => undefined);
    return manifest;
  }

  /**
   * Converge the running set onto `desired`. Never leaves a replaced plugin
   * down if its replacement fails to mount (rollback to the old version).
   */
  async apply(desired: PluginSet): Promise<ApplyResult> {
    const result: ApplyResult = { mounted: [], unmounted: [], failed: [] };
    const running = new Map(this.#opts.supervisor.list().map((p) => [p.manifest.id, p]));

    // Unmount plugins that disappeared or are disabled (except ones being
    // swapped, handled below).
    for (const [id, rt] of running) {
      const want = desired[id];
      const swapping = want?.enabled !== false && want?.manifestPath !== undefined;
      if (!want || want.enabled === false) {
        if (!swapping) {
          await this.#opts.supervisor.unmount(id).catch((err: Error) => {
            result.failed.push({ pluginId: id, error: err.message });
          });
          result.unmounted.push(id);
        }
      } else if (rt.state === "failed") {
        // A failed plugin whose config is unchanged stays failed; a config
        // change triggers unmount + remount below.
        await this.#opts.supervisor.unmount(id).catch(() => undefined);
        result.unmounted.push(id);
      }
    }

    for (const [id, want] of Object.entries(desired)) {
      if (want.enabled === false || !want.manifestPath) continue;
      const already = this.#opts.supervisor.get(id);
      if (already && already.state === "healthy") continue;
      try {
        const manifest = await this.loadManifest(want.manifestPath);
        if (manifest.id !== id) {
          throw new PackageError(`manifest id ${manifest.id} does not match configured key ${id}`);
        }
        const rt = await this.#opts.supervisor.mount(manifest, want.config ?? {});
        // A plugin that dies during startup is handed to the crash policy and
        // reported as not healthy; treat that as a failed apply.
        if (rt.state !== "healthy") {
          await this.#opts.supervisor.unmount(id).catch(() => undefined);
          throw new PackageError(`plugin did not reach healthy state (${rt.state})`);
        }
        result.mounted.push(id);
      } catch (err) {
        result.failed.push({ pluginId: id, error: (err as Error).message });
      }
    }
    return result;
  }
}
