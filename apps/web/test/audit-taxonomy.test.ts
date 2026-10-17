import { describe, expect, it } from "vitest";
import {
  classifyOperationsLogAction,
  OPERATIONS_LOG_CATEGORIES,
  OPERATIONS_LOG_CATEGORY_COLORS,
} from "../src/admin/views";

describe("operations log taxonomy", () => {
  it.each([
    ["user.password.reset", "Access"],
    ["dev.tantalar.event.plugin.crashed", "Extensions"],
    ["dev.tantalar.event.download.progress", "Acquisition"],
    ["acquisition.vpn.preflight", "Acquisition"],
    ["dev.tantalar.event.library.rescan.completed", "Media"],
    ["dev.tantalar.event.playback.started", "Playback"],
    ["webhook.tested", "Automation"],
    ["client.incident.reported", "System"],
    ["dev.example.unknown", "Other"],
  ] as const)("classifies %s as %s", (action, expected) => {
    expect(classifyOperationsLogAction(action)).toBe(expected);
  });

  it("assigns a distinct quiet palette entry to every visible label", () => {
    const colors = OPERATIONS_LOG_CATEGORIES.map((category) => OPERATIONS_LOG_CATEGORY_COLORS[category]);
    expect(new Set(colors).size).toBe(OPERATIONS_LOG_CATEGORIES.length);
  });
});
