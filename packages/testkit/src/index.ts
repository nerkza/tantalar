export * from "./conformance.js";

/**
 * In-memory plugin stub for conformance tests (ADR-0013). Never used at runtime.
 */
import type { PluginDefinition, PluginContext } from "@tantalar/plugin-sdk";
import type { PluginManifest } from "@tantalar/contracts";

export function stubPlugin(manifest: PluginManifest): PluginDefinition {
  return {
    manifest,
    mount(ctx: PluginContext) {
      ctx.log("info", "stub mounted");
    },
    unmount(ctx: PluginContext) {
      ctx.log("info", "stub unmounted");
    },
  };
}
