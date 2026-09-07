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
    expect(el.style.getPropertyValue("--mantine-color-default")).toBe("var(--tantalar-color-surface-raised)");
    expect(el.style.getPropertyValue("--mantine-primary-color-filled")).toBe("var(--tantalar-color-primary)");
    expect(el.style.getPropertyValue("--mantine-primary-color-contrast")).toBe("var(--tantalar-color-primary-contrast)");
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
      payload: {
        itemKey: "show:s01e01",
        winnerGuid: "good-rel",
        rankedGuids: ["good-rel"],
        candidates: [{ guid: "good-rel", title: "Tracer Show S01E01 1080p" }],
      },
    }),
    ev({
      eventId: "3",
      type: "dev.tantalar.event.grab.decision",
      correlationId: "corr-x",
      payload: { itemKey: "show:s01e01", decided: true, guid: "good-rel", mode: "automatic" },
    }),
    ev({
      eventId: "4",
      type: "dev.tantalar.event.dispatch.gate.checked",
      correlationId: "corr-x",
      payload: { clientId: "dev.tantalar.plugin.torrent-native", allowed: true },
    }),
    ev({
      eventId: "5",
      type: "dev.tantalar.event.client.dispatch",
      correlationId: "corr-x",
      payload: { downloadId: "d1" },
    }),
    ev({
      eventId: "6",
      type: "dev.tantalar.event.download.progress",
      correlationId: "corr-x",
      payload: { downloadId: "d1", verification: { verifiedPieces: 3, totalPieces: 3 } },
    }),
    ev({
      eventId: "7",
      type: "dev.tantalar.event.download.completed",
      correlationId: "corr-x",
      payload: { downloadId: "d1" },
    }),
    ev({
      eventId: "8",
      type: "dev.tantalar.event.import.started",
      correlationId: "corr-x",
      payload: { itemKey: "show:s01e01" },
    }),
    ev({
      eventId: "9",
      type: "dev.tantalar.event.import.completed",
      correlationId: "corr-x",
      payload: { path: "/library/show/s01e01.mkv" },
    }),
    ev({
      eventId: "10",
      type: "dev.tantalar.event.download.progress",
      correlationId: "corr-x",
      payload: { downloadId: "d1", recovered: true },
    }),
  ];

  it("reconstructs a full grab→import narrative", () => {
    const [chain] = assembleChains(chainEvents());
    const n = reconstructDecision(chain);
    expect(n.summary).toContain('Grabbed "Tracer Show S01E01 1080p"');
    expect(n.summary).toContain("won release comparison");
    expect(n.complete).toBe(true);
    expect(n.steps[0]!.label).toBe("Searched indexers");
    expect(n.steps.map((step) => step.label)).toContain("VPN gate passed");
    expect(n.steps.map((step) => step.label)).toContain("Download verified");
    expect(n.steps.map((step) => step.label)).toContain("Download recovered");
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

  it("shows the selected title and assessment messages without exposing its fingerprint", () => {
    const winnerId = "a".repeat(64);
    const selectedId = "b".repeat(64);
    const chain = assembleChains([
      ev({
        eventId: "1",
        type: "dev.tantalar.event.release.decision.recorded",
        correlationId: "interactive-choice",
        payload: {
          winnerCandidateId: winnerId,
          assessments: [
            {
              candidateId: winnerId,
              title: "Tracer Show S01E01 1080p",
              accepted: true,
              reasons: [{ code: "best_quality_available", message: "Best quality available (1080p)" }],
            },
            {
              candidateId: selectedId,
              title: "Tracer Show S01E01 1080p Alternate",
              accepted: true,
              reasons: [
                { code: "preferred_quality", message: "Quality matches the monitoring profile" },
                { code: "eligible_lower_ranked", message: "Eligible, but ranked below another release" },
              ],
            },
          ],
        },
      }),
      ev({
        eventId: "2",
        type: "dev.tantalar.event.comparison.verdict",
        correlationId: "interactive-choice",
        payload: {
          winnerGuid: winnerId,
          candidates: [
            { guid: winnerId, title: "Tracer Show S01E01 1080p" },
            { guid: selectedId, title: "Tracer Show S01E01 1080p Alternate" },
          ],
        },
      }),
      ev({
        eventId: "3",
        type: "dev.tantalar.event.grab.decision",
        correlationId: "interactive-choice",
        payload: { decided: true, releaseId: selectedId, mode: "interactive" },
      }),
    ])[0];

    const narrative = reconstructDecision(chain);

    expect(narrative.summary).toContain('Grabbed "Tracer Show S01E01 1080p Alternate"');
    expect(narrative.summary).toContain("Eligible, but ranked below another release");
    expect(narrative.summary).not.toContain(selectedId);
    expect(narrative.steps.map((step) => step.detail).join(" ")).toContain("Quality matches the monitoring profile");
    expect(narrative.steps.map((step) => step.detail).join(" ")).toContain("Eligible, but ranked below another release");
  });
});
