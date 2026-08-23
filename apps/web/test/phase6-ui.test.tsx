/**
 * Phase 6 unit tests: design tokens + CSS sanitization, correlation-chain
 * assembly, and decision reconstruction from the event log.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TOKENS,
  TOKEN_PREFIX,
  applyTokens,
  sanitizeTokenOverrides,
  tokensToCssVariables,
} from "../src/theme/tokens";
import {
  assembleChains,
  reconstructDecision,
} from "../src/activity/trajectory";
import type { TrajectoryEvent } from "../src/activity/trajectory";

// ---- Tokens & sanitizer ------------------------------------------------------

describe("design tokens", () => {
  it("defaults all use the --tantalar- prefix", () => {
    for (const key of Object.keys(DEFAULT_TOKENS)) {
      expect(TOKEN_PREFIX).toBe("--tantalar-");
      expect(key.startsWith("--")).toBe(false);
    }
    const css = tokensToCssVariables();
    expect(css).toContain("--tantalar-color-bg:#10121a");
    expect(css.split(";").every((d) => d.startsWith("--tantalar-"))).toBe(true);
  });

  it("sanitizeTokenOverrides accepts plain color and length values", () => {
    const res = sanitizeTokenOverrides({
      "--tantalar-color-primary": "#ff8800",
      "--tantalar-space-unit": "6px",
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.tokens["color-primary"]).toBe("#ff8800");
      expect(res.tokens["space-unit"]).toBe("6px");
    }
  });

  it.each([
    ["script via url()", { "color-bg": "url(javascript:alert(1))" }],
    ["expression()", { "color-bg": "expression(alert(1))" }],
    ["at-rule injection", { "color-bg": "@import 'evil.css'" }],
    ["html injection", { "color-bg": "<script>alert(1)</script>" }],
    ["css escape", { "color-bg": "\\6a\\61\\76\\61" }],
    ["rule block", { "color-bg": "{position:absolute}" }],
  ])("rejects %s", (_name, input) => {
    const res = sanitizeTokenOverrides(input as Record<string, string>);
    expect(res.ok).toBe(false);
  });

  it("applyTokens writes variables to an element style", () => {
    const el = document.createElement("div");
    applyTokens(el, { "color-primary": "#123456" });
    expect(el.style.getPropertyValue("--tantalar-color-primary")).toBe("#123456");
    // Defaults are filled in too.
    expect(el.style.getPropertyValue("--tantalar-color-text")).not.toBe("");
  });
});

// ---- Correlation chains --------------------------------------------------------

function ev(partial: Partial<TrajectoryEvent> & { eventId: string; type: string }): TrajectoryEvent {
  return {
    occurredAt: "2026-08-22T12:00:00Z",
    producer: "core",
    payload: {},
    ...partial,
  } as TrajectoryEvent;
}

describe("correlation-chain assembly", () => {
  it("groups events by correlationId and orders chronologically", () => {
    const events = [
      ev({ eventId: "e3", type: "a", correlationId: "c1", occurredAt: "2026-08-22T12:00:03Z" }),
      ev({ eventId: "e1", type: "b", correlationId: "c1", occurredAt: "2026-08-22T12:00:01Z" }),
      ev({ eventId: "e2", type: "c", occurredAt: "2026-08-22T11:00:00Z" }),
    ];
    const chains = assembleChains(events);
    expect(chains).toHaveLength(2);
    const c1 = chains.find((c) => c.correlationId === "c1")!;
    expect(c1.events.map((e) => e.eventId)).toEqual(["e1", "e3"]);
  });
});

describe("decision reconstruction (grab→import)", () => {
  const chainEvents = (): TrajectoryEvent[] => [
    ev({
      eventId: "1",
      type: "dev.tantalar.event.indexer.searched",
      correlationId: "corr-x",
      payload: { query: "S01E01" },
    }),
    ev({
      eventId: "2",
      type: "dev.tantalar.event.comparison.verdict",
      correlationId: "corr-x",
      payload: { itemKey: "show:s01e01", winnerGuid: "good-rel", rankedGuids: ["good-rel"] },
    }),
    ev({
      eventId: "3",
      type: "dev.tantalar.event.grab.decision",
      correlationId: "corr-x",
      payload: { itemKey: "show:s01e01", decided: true, guid: "good-rel", mode: "automatic" },
    }),
    ev({
      eventId: "4",
      type: "dev.tantalar.event.client.dispatch",
      correlationId: "corr-x",
      payload: { downloadId: "d1" },
    }),
    ev({
      eventId: "5",
      type: "dev.tantalar.event.download.completed",
      correlationId: "corr-x",
      payload: { downloadId: "d1" },
    }),
    ev({
      eventId: "6",
      type: "dev.tantalar.event.import.started",
      correlationId: "corr-x",
      payload: { itemKey: "show:s01e01" },
    }),
    ev({
      eventId: "7",
      type: "dev.tantalar.event.import.completed",
      correlationId: "corr-x",
      payload: { path: "/library/show/s01e01.mkv" },
    }),
  ];

  it("reconstructs a full grab→import narrative", () => {
    const [chain] = assembleChains(chainEvents());
    const n = reconstructDecision(chain);
    expect(n.summary).toContain('Grabbed "good-rel"');
    expect(n.summary).toContain("won release comparison");
    expect(n.complete).toBe(true);
    expect(n.steps[0]!.label).toBe("Searched indexers");
    expect(n.steps.at(-1)!.label).toBe("Import completed");
  });

  it("explains a non-grab decision", () => {
    const chain = assembleChains([
      ev({ eventId: "1", type: "dev.tantalar.event.comparison.verdict", correlationId: "c", payload: { winnerGuid: null } }),
      ev({ eventId: "2", type: "dev.tantalar.event.grab.decision", correlationId: "c", payload: { decided: false, reason: "no_qualifying_release" } }),
    ])[0];
    const n = reconstructDecision(chain);
    expect(n.summary).toBe("Nothing was grabbed: no qualifying release.");
    expect(n.complete).toBe(false);
  });
});
