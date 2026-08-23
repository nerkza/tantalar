/**
 * Service container: manifest-declared capabilities, reverse-DNS names
 * (ADR-0006). Resolution fails hard on missing or ambiguous providers.
 */
import { isReverseDns } from "@tantalar/contracts";

export interface CapabilityProvider {
  readonly pluginId: string;
  readonly capability: string;
  invoke(operation: string, payload: Record<string, unknown>): Promise<unknown>;
}

export class CapabilityResolutionError extends Error {}
export class AmbiguousCapabilityError extends CapabilityResolutionError {}

export class ServiceContainer {
  readonly #providers = new Map<string, CapabilityProvider[]>();

  register(provider: CapabilityProvider): () => void {
    if (!isReverseDns(provider.capability)) {
      throw new Error(`capability name must be reverse-DNS: ${provider.capability}`);
    }
    const list = this.#providers.get(provider.capability) ?? [];
    list.push(provider);
    this.#providers.set(provider.capability, list);
    return () => {
      const cur = this.#providers.get(provider.capability) ?? [];
      const idx = cur.indexOf(provider);
      if (idx >= 0) cur.splice(idx, 1);
    };
  }

  resolve(capability: string): CapabilityProvider {
    const list = this.#providers.get(capability) ?? [];
    if (list.length === 0) {
      throw new CapabilityResolutionError(`no provider for capability ${capability}`);
    }
    if (list.length > 1) {
      throw new AmbiguousCapabilityError(
        `ambiguous capability ${capability}: providers ${list.map((p) => p.pluginId).join(", ")}`,
      );
    }
    return list[0] as CapabilityProvider;
  }

  hasProviders(capability: string): boolean {
    return (this.#providers.get(capability)?.length ?? 0) > 0;
  }

  /** Strict check used at mount/boot: every required name must resolve. */
  assertResolvable(requires: readonly string[]): void {
    for (const cap of requires) this.resolve(cap);
  }

  snapshot(): Array<{ capability: string; pluginId: string }> {
    const out: Array<{ capability: string; pluginId: string }> = [];
    for (const [cap, list] of this.#providers) {
      for (const p of list) out.push({ capability: cap, pluginId: p.pluginId });
    }
    return out;
  }
}
