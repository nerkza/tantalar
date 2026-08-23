import { describe, expect, it } from "vitest";
import {
  AmbiguousCapabilityError,
  CapabilityResolutionError,
  ServiceContainer,
} from "../apps/server/src/container.js";
import { validateEnvelope, validateManifest, uuidv7 } from "@tantalar/contracts";

describe("service container (ADR-0006)", () => {
  it("resolves a single provider", () => {
    const c = new ServiceContainer();
    c.register({ pluginId: "p1", capability: "dev.tantalar.capability.x", invoke: async () => 42 });
    const p = c.resolve("dev.tantalar.capability.x");
    expect(p.pluginId).toBe("p1");
  });

  it("fails hard on missing providers", () => {
    const c = new ServiceContainer();
    expect(() => c.resolve("dev.tantalar.capability.missing")).toThrow(CapabilityResolutionError);
  });

  it("fails hard on ambiguous providers", () => {
    const c = new ServiceContainer();
    c.register({ pluginId: "a", capability: "dev.tantalar.capability.dup", invoke: async () => 1 });
    c.register({ pluginId: "b", capability: "dev.tantalar.capability.dup", invoke: async () => 2 });
    expect(() => c.resolve("dev.tantalar.capability.dup")).toThrow(AmbiguousCapabilityError);
  });

  it("rejects non-reverse-DNS capability names", () => {
    const c = new ServiceContainer();
    expect(() =>
      c.register({ pluginId: "a", capability: "not-reverse-dns", invoke: async () => 1 }),
    ).toThrow(/reverse-DNS/);
  });

  it("unregister restores resolution failure (reversible registration)", () => {
    const c = new ServiceContainer();
    const un = c.register({ pluginId: "a", capability: "dev.tantalar.capability.r", invoke: async () => 1 });
    un();
    expect(c.hasProviders("dev.tantalar.capability.r")).toBe(false);
  });
});

describe("envelope and manifest validation (ADR-0007/0008)", () => {
  it("uuidv7 sorts by time and validates", () => {
    const a = uuidv7();
    const b = uuidv7(Date.now() + 5);
    expect(a < b).toBe(true);
  });

  it("valid envelope passes; bad ones fail", () => {
    const good = {
      schemaVersion: 1,
      eventId: uuidv7(),
      type: "dev.tantalar.event.test",
      occurredAt: new Date().toISOString(),
      producer: "core",
      payload: {},
    };
    expect(validateEnvelope(good)).toBeTruthy();
    expect(() => validateEnvelope({ ...good, type: "nope" })).toThrow(/reverse-DNS/);
    expect(() => validateEnvelope({ ...good, schemaVersion: 2 })).toThrow(/schemaVersion/);
    expect(() => validateEnvelope({ ...good, eventId: "xyz" })).toThrow(/eventId/);
  });

  it("manifest validation enforces protocol version and reverse-DNS", () => {
    const m = {
      id: "dev.tantalar.plugin.test",
      version: "0.1.0",
      protocolVersion: 1,
      provides: ["dev.tantalar.capability.a"],
      requires: [],
      subscriptions: [],
      entry: { command: "node dist/plugin.js" },
    };
    expect(validateManifest(m)).toBeTruthy();
    expect(() => validateManifest({ ...m, protocolVersion: 99 })).toThrow(/protocolVersion/);
    expect(() => validateManifest({ ...m, id: "Bad Name" })).toThrow(/reverse-DNS/);
  });
});
