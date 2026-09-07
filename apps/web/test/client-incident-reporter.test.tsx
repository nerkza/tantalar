import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

const apiMock = vi.hoisted(() => ({ reportClientIncident: vi.fn(), version: vi.fn() }));
vi.mock("../src/api", () => ({ api: apiMock }));

import { ClientIncidentReporter, visibleStallDuration } from "../src/shell/ClientIncidentReporter";

beforeEach(() => {
  apiMock.reportClientIncident.mockReset().mockResolvedValue({ recorded: true, duplicate: false });
  apiMock.version.mockReset().mockResolvedValue({ version: "0.0.1-alpha.0", label: "0.0.1 Alpha", channel: "alpha", build: {} });
});

afterEach(() => cleanup());

describe("ClientIncidentReporter", () => {
  it("captures and deduplicates repeated window errors", async () => {
    render(<ClientIncidentReporter enabled appVersion="0.0.1-alpha.0" />);
    const error = new Error("Control renderer failed");
    await act(async () => {
      window.dispatchEvent(new ErrorEvent("error", { message: error.message, error }));
      window.dispatchEvent(new ErrorEvent("error", { message: error.message, error }));
      await Promise.resolve();
    });
    expect(apiMock.reportClientIncident).toHaveBeenCalledTimes(1);
    expect(apiMock.reportClientIncident).toHaveBeenCalledWith(expect.objectContaining({
      kind: "window-error",
      appVersion: "0.0.1-alpha.0",
      fingerprint: expect.stringMatching(/^fnv1a-/),
    }));
  });

  it("captures unhandled promise rejections without serializing arbitrary objects", async () => {
    render(<ClientIncidentReporter enabled />);
    const rejection = new Event("unhandledrejection");
    Object.defineProperty(rejection, "reason", { value: { password: "do-not-copy" } });
    await act(async () => {
      window.dispatchEvent(rejection);
      await Promise.resolve();
    });
    expect(apiMock.reportClientIncident).toHaveBeenCalledWith(expect.objectContaining({
      kind: "unhandled-rejection",
      message: "Unhandled promise rejection (Object)",
    }));
    expect(JSON.stringify(apiMock.reportClientIncident.mock.calls[0])).not.toContain("do-not-copy");
  });

  it("only classifies a heartbeat delay as a stall while visible", () => {
    expect(visibleStallDuration(4_000, 1_000, 2_500, true)).toBe(3_000);
    expect(visibleStallDuration(3_000, 1_000, 2_500, true)).toBeNull();
    expect(visibleStallDuration(8_000, 1_000, 2_500, false)).toBeNull();
  });
});
