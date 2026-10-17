import type { Kysely } from "kysely";
import type { Db } from "@tantalar/db";
import { ONBOARDING_STEPS, type OnboardingState, type OnboardingStepId, type OnboardingPreferences, type OnboardingStepState } from "@tantalar/contracts";
export { ONBOARDING_STEPS } from "@tantalar/contracts";

const ROW_ID = "global";
const finished = (step: OnboardingStepState) => step.status === "done" || step.status === "skipped";
const initialState = (): OnboardingState => ({
  version: 2,
  steps: Object.fromEntries(ONBOARDING_STEPS.map(id => [id, { status: "pending" }])) as OnboardingState["steps"],
  currentStep: "administrator", mediaEnabled: false, acquisitionMode: "none", titleFileId: null,
  metadataQuery: "", complete: false,
});

function parseState(raw: string | null): OnboardingState {
  const state = initialState();
  if (!raw) return state;
  try {
    const saved = JSON.parse(raw);
    if (!saved || typeof saved !== "object") return state;
    if (saved.version === 2) {
      for (const id of ONBOARDING_STEPS) {
        const step = saved.steps?.[id];
        if (step && ["pending", "configured", "done", "skipped", "failed"].includes(step.status)) {
          state.steps[id] = { status: step.status,
            ...(typeof step.detail === "string" ? { detail: step.detail } : {}),
            ...(typeof step.checkedAt === "string" ? { checkedAt: step.checkedAt } : {}),
          };
        }
      }
      state.mediaEnabled = saved.mediaEnabled === true;
      if (["none", "usenet", "torrent"].includes(saved.acquisitionMode)) state.acquisitionMode = saved.acquisitionMode;
      if (ONBOARDING_STEPS.includes(saved.currentStep)) state.currentStep = saved.currentStep;
      if (typeof saved.titleFileId === "string") state.titleFileId = saved.titleFileId;
      if (typeof saved.metadataQuery === "string") state.metadataQuery = saved.metadataQuery;
      if (saved.releaseTarget && ["movie", "series"].includes(saved.releaseTarget.kind) && typeof saved.releaseTarget.id === "string") {
        state.releaseTarget = { kind: saved.releaseTarget.kind, id: saved.releaseTarget.id,
          ...(typeof saved.releaseTarget.episodeKey === "string" ? { episodeKey: saved.releaseTarget.episodeKey } : {}) };
      }
      if (typeof saved.downloadJobId === "string") state.downloadJobId = saved.downloadJobId;
      state.complete = saved.complete === true;
      return state;
    }
    // Legacy completion is preserved. A recorded completion was not proof of playback.
    const legacyIds = ["administrator", "storage", "libraries", "download-engines", "indexers", "metadata", "vpn-policy", "final-health"];
    const complete = legacyIds.every(id => ["done", "skipped"].includes(saved[id]?.status));
    state.mediaEnabled = complete || saved.libraries?.status === "done";
    for (const id of ONBOARDING_STEPS) {
      if (saved[id]?.status === "skipped") state.steps[id] = { status: "skipped" };
      else if (saved[id]?.status === "done") state.steps[id] = { status: "configured", detail: "Saved by the previous setup. Verification not recorded." };
      if (complete && !saved[id]) state.steps[id] = { status: "skipped", detail: "Not checked by the previous setup." };
    }
    if (saved.administrator?.status === "done") state.steps.administrator = { status: "done" };
    if (complete) state.steps["final-health"] = { status: "done", detail: "Previous setup completed." };
    state.complete = complete;
    state.currentStep = complete ? "final-health" : state.steps.administrator.status === "done" ? "experience" : "administrator";
    return state;
  } catch { return state; }
}

export class OnboardingError extends Error {
  constructor(message: string, readonly statusCode: number) { super(message); }
}

export class OnboardingService {
  constructor(readonly db: Kysely<Db>) {}

  async getState(): Promise<OnboardingState> {
    await this.db.insertInto("onboarding_state").values({ id: ROW_ID, steps: JSON.stringify(initialState()), updatedAt: new Date().toISOString() })
      .onConflict(oc => oc.column("id").doNothing()).execute();
    const row = await this.db.selectFrom("onboarding_state").select("steps").where("id", "=", ROW_ID).executeTakeFirstOrThrow();
    return parseState(row.steps);
  }

  /** Compare-and-swap prevents two tabs from silently replacing each other's progress. */
  async change(update: (state: OnboardingState) => void): Promise<OnboardingState> {
    await this.getState();
    for (let attempt = 0; attempt < 5; attempt++) {
      const row = await this.db.selectFrom("onboarding_state").select("steps").where("id", "=", ROW_ID).executeTakeFirstOrThrow();
      const state = parseState(row.steps);
      update(state);
      const result = await this.db.updateTable("onboarding_state").set({ steps: JSON.stringify(state), updatedAt: new Date().toISOString() })
        .where("id", "=", ROW_ID).where("steps", "=", row.steps).executeTakeFirst();
      if (Number(result.numUpdatedRows) === 1) return state;
    }
    throw new OnboardingError("Setup changed in another session. Reload and retry.", 409);
  }

  async preferences(input: OnboardingPreferences): Promise<OnboardingState> {
    return this.change(state => {
      if (input.mediaEnabled !== undefined && input.mediaEnabled !== state.mediaEnabled) {
        state.mediaEnabled = input.mediaEnabled;
        if (!state.complete) state.steps.playback = input.mediaEnabled ? { status: "pending" } : { status: "skipped", detail: "Tantalar Media is disabled." };
      }
      if (input.acquisitionMode !== undefined && input.acquisitionMode !== state.acquisitionMode) {
        state.acquisitionMode = input.acquisitionMode;
        state.steps.acquisition = { status: "pending" };
      }
      if (input.titleFileId !== undefined && input.titleFileId !== state.titleFileId) {
        state.titleFileId = input.titleFileId;
        state.steps["first-title"] = { status: "pending" };
        if (state.mediaEnabled) state.steps.playback = { status: "pending" };
      }
      if (input.metadataQuery !== undefined) state.metadataQuery = input.metadataQuery;
      if (input.releaseTarget !== undefined) state.releaseTarget = input.releaseTarget;
      if (input.downloadJobId !== undefined) state.downloadJobId = input.downloadJobId;
      if (input.currentStep !== undefined) state.currentStep = input.currentStep;
    });
  }

  async setStep(stepId: string, action: "complete" | "skip", check?: OnboardingStepState, checkedState?: OnboardingState): Promise<OnboardingState> {
    if (!(ONBOARDING_STEPS as readonly string[]).includes(stepId)) throw new OnboardingError(`"${stepId}" is not an onboarding step. Open Setup.`, 404);
    const id = stepId as OnboardingStepId;
    if (action === "skip" && ["administrator", "experience", "final-health"].includes(id)) throw new OnboardingError("This step is required and cannot be skipped.", 400);
    return this.change(state => {
      if (checkedState && (["mediaEnabled", "acquisitionMode", "titleFileId", "metadataQuery", "downloadJobId"] as const)
        .some(key => state[key] !== checkedState[key])) throw new OnboardingError("Setup choices changed during this check. Run it again.", 409);
      if (id === "final-health") {
        if (ONBOARDING_STEPS.some(step => step !== id && !finished(state.steps[step]))) throw new OnboardingError("Finish or skip the earlier setup steps before review.", 409);
        if (check?.status !== "done") throw new OnboardingError("Run the server check before finishing setup.", 409);
        state.complete = true;
      }
      if (action === "skip") state.steps[id] = { ...state.steps[id], status: "skipped" };
      else if (["administrator", "experience"].includes(id)) {
        state.steps[id] = { status: "done" };
        if (id === "experience" && !state.mediaEnabled) state.steps.playback = { status: "skipped", detail: "Tantalar Media is disabled." };
      }
      else {
        if (!check) throw new OnboardingError("Run this step's check before continuing.", 409);
        state.steps[id] = { ...check, checkedAt: new Date().toISOString() };
      }
      if (finished(state.steps[id])) state.currentStep = ONBOARDING_STEPS.find(step => !finished(state.steps[step])) ?? "final-health";
    });
  }
}
