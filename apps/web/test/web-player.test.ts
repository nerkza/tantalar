/**
 * Phase 5B web app unit/integration tests: srt→vtt conversion, progress
 * reporting semantics (monotonic + rewind escape), negotiation decision
 * handling against a mocked fetch, and library page rendering boundaries.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// ---- engine -------------------------------------------------------------------

const { attachPlayback, srtToVtt } = await import("../src/player/engine.js");
const { ProgressReporter } = await import("../src/player/progress.js");

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation(() => ({
      matches: false,
      media: "",
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

describe("srtToVtt", () => {
  it("converts an SRT payload into valid WebVTT", () => {
    const srt = "1\n00:00:01,000 --> 00:00:02,500\nHello\n";
    const vtt = srtToVtt(srt);
    expect(vtt.startsWith("WEBVTT")).toBe(true);
    expect(vtt).toContain("00:00:01.000 --> 00:00:02.500");
  });
});

function makeVideo(): HTMLVideoElement {
  const v = document.createElement("video");
  Object.defineProperty(v, "duration", { value: 100, configurable: true });
  return v;
}

describe("attachPlayback", () => {
  it("direct mode sets src and reports the original-quality label", () => {
    const video = makeVideo();
    const onQualities = vi.fn();
    const engine = attachPlayback(
      video,
      { mode: "direct", streamUrl: "/api/v1/stream/f-x" },
      { onQualities, onError: () => undefined },
    );
    expect(video.getAttribute("src")).toBe("/api/v1/stream/f-x");
    expect(onQualities).toHaveBeenCalledWith([{ index: -1, label: "Direct (original)" }]);
    engine.destroy();
    expect(video.getAttribute("src")).toBeNull();
  });

  it("setQuality is a safe no-op in direct mode", () => {
    const video = makeVideo();
    const engine = attachPlayback(
      video,
      { mode: "direct", streamUrl: "/s" },
      { onQualities: () => undefined, onError: () => undefined },
    );
    expect(() => engine.setQuality(2)).not.toThrow();
    engine.destroy();
  });
});

// ---- progress reporter ----------------------------------------------------------

import { api } from "../src/api.js";
const { ensurePlaybackReady, PlayerPage } = await import("../src/pages/PlayerPage.js");

function mockApiSetResume() {
  const calls: Array<{ positionMs: number; allowRewind?: boolean }> = [];
  const original = api.setResume;
  api.setResume = ((fileId: string, positionMs: number, durationMs?: number, allowRewind?: boolean) => {
    calls.push({ positionMs, allowRewind });
    return Promise.resolve({ accepted: true });
  }) as typeof api.setResume;
  return {
    calls,
    restore: () => {
      api.setResume = original;
    },
  };
}

describe("ProgressReporter", () => {
  let mocked: ReturnType<typeof mockApiSetResume>;

  beforeEach(() => {
    mocked = mockApiSetResume();
  });
  afterEach(() => {
    mocked.restore();
    cleanup();
  });

  function makeVideoWithTime(currentTime: number): HTMLVideoElement {
    const v = document.createElement("video");
    Object.defineProperty(v, "duration", { value: 600, configurable: true });
    Object.defineProperty(v, "currentTime", { value: currentTime, configurable: true });
    return v;
  }

  it("reports forward progress monotonically", async () => {
    const reporter = new ProgressReporter("f-x", 10);
    const v1 = makeVideoWithTime(5);
    reporter.tick(v1, false);
    const v2 = makeVideoWithTime(20);
    reporter.tick(v2, false);
    await vi.waitFor(() => expect(mocked.calls.length).toBe(2));
    expect(mocked.calls[0]!.positionMs).toBe(5000);
    expect(mocked.calls[1]!.positionMs).toBe(20000);
    reporter.stop();
  });

  it("suppresses non-user rewinds but sends user seeks with allowRewind", async () => {
    const reporter = new ProgressReporter("f-x", 10);
    reporter.tick(makeVideoWithTime(100), false);
    // Non-user late-arriving older event → suppressed.
    reporter.tick(makeVideoWithTime(10), false);
    // User seek back → sent with allowRewind.
    reporter.tick(makeVideoWithTime(30), true);
    await vi.waitFor(() => expect(mocked.calls.length).toBe(2));
    expect(mocked.calls[1]!.allowRewind).toBe(true);
    expect(mocked.calls[1]!.positionMs).toBe(30000);
    reporter.stop();
  });
});

describe("PlayerPage HLS startup", () => {
  it("starts the real transcode session before attaching HLS playback", async () => {
    const original = api.startTranscodeSession;
    const start = vi.fn().mockResolvedValue({ started: "session-1", ready: true });
    api.startTranscodeSession = start;
    try {
      await ensurePlaybackReady({
        mode: "hls",
        sessionId: "session-1",
        manifestUrl: "/api/v1/hls/session-1/manifest.m3u8",
        qualities: ["1280x720"],
      });
      expect(start).toHaveBeenCalledWith("session-1");
    } finally {
      api.startTranscodeSession = original;
    }
  });

  it("stops local playback when the server ends the session", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const originals = {
      negotiate: api.negotiate,
      subtitles: api.subtitles,
      browse: api.browse,
      resumePoint: api.resumePoint,
      touchPlaybackSession: api.touchPlaybackSession,
      closePlaybackSession: api.closePlaybackSession,
      setResume: api.setResume,
    };
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    const load = vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const missing = Object.assign(new Error("unknown session"), { status: 404 });
    api.negotiate = vi.fn().mockResolvedValue({
      decision: { mode: "direct", sessionId: "session-1", streamUrl: "/stream", reason: "direct" },
    });
    api.subtitles = vi.fn().mockResolvedValue({ tracks: [] });
    api.browse = vi.fn().mockResolvedValue({ items: [] });
    api.resumePoint = vi.fn().mockResolvedValue({ resumePoint: null });
    api.touchPlaybackSession = vi.fn().mockRejectedValue(missing);
    api.closePlaybackSession = vi.fn().mockResolvedValue({ closed: true });
    api.setResume = vi.fn().mockResolvedValue({ accepted: true });

    try {
      render(createElement(MantineProvider, null,
        createElement(QueryClientProvider, { client }, createElement(PlayerPage, { fileId: "file-1" })),
      ));
      await vi.waitFor(() => expect(screen.getByTestId("player-page").getAttribute("data-mode")).toBe("direct"));
      await act(async () => vi.advanceTimersByTimeAsync(10_000));
      expect(screen.getAllByText(/Playback session ended on the server/).length).toBeGreaterThan(0);
      expect(pause).toHaveBeenCalled();
      expect(load).toHaveBeenCalled();
      expect(screen.getByTestId("player-video").getAttribute("src")).toBeNull();
    } finally {
      Object.assign(api, originals);
      client.clear();
      pause.mockRestore();
      load.mockRestore();
      vi.useRealTimers();
      cleanup();
    }
  });
});
