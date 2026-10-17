import { afterEach, expect, it, vi } from "vitest";
import { ONBOARDING_STEPS } from "@tantalar/contracts";
import { api } from "../src/api";

afterEach(() => vi.unstubAllGlobals());

it("rejects incompatible onboarding responses across reads and saves", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const current = {
    version: 2, currentStep: "experience", mediaEnabled: false,
    acquisitionMode: "none", titleFileId: null, metadataQuery: "", complete: false,
    steps: Object.fromEntries(ONBOARDING_STEPS.map(id => [id, { status: "pending" }])),
  };
  for (const call of [api.onboarding, () => api.onboardPreferences({ mediaEnabled: false }), () => api.onboardStep("experience", "complete")]) {
    for (const incompatible of [null, { steps: { administrator: { status: "done" } }, complete: false }, { ...current, steps: {} }]) {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(incompatible)));
      await expect(call()).rejects.toThrow(/restart the Tantalar server/i);
    }
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(current)));
    await expect(call()).resolves.toEqual(current);
  }
});
