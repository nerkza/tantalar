import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("API stability boundaries", () => {
  it("times out a request with a friendly error", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_path: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    })));

    const pending = api.events();
    const assertion = expect(pending).rejects.toThrow("Tantalar took too long to respond. Please try again.");
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
  });

  it("passes query cancellation through to fetch", async () => {
    let fetchSignal: AbortSignal | null | undefined;
    vi.stubGlobal("fetch", vi.fn((_path: string, init?: RequestInit) => {
      fetchSignal = init?.signal;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    }));
    const controller = new AbortController();
    const pending = api.events({}, { signal: controller.signal }).catch(() => undefined);
    controller.abort();
    await pending;
    expect(fetchSignal?.aborted).toBe(true);
  });

  it("turns a network failure into an actionable message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(api.events()).rejects.toThrow(
      "Could not reach Tantalar. Check that the server is running and try again.",
    );
  });
});
