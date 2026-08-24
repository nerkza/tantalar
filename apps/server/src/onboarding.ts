/**
 * Guided onboarding (wave 2, TAN-003): a durable, resumable wizard covering
 * administrator, storage, libraries, download engines, indexers, metadata,
 * VPN policy, and final health.
 *
 * State lives in the `onboarding_state` table (exactly one row, id
 * "global") so completion survives restarts. Optional steps can be skipped;
 * every step can be resumed until done or skipped. The final step cannot be
 * completed until every other step is done or skipped — fail closed, with a
 * product-facing recovery message.
 */
import type { Kysely } from "kysely";
import type { Db } from "@tantalar/db";

export const ONBOARDING_STEPS = [
  "administrator",
  "storage",
  "libraries",
  "download-engines",
  "indexers",
  "metadata",
  "vpn-policy",
  "final-health",
] as const;

export type OnboardingStepId = (typeof ONBOARDING_STEPS)[number];

export type StepStatus = "pending" | "done" | "skipped";

export interface StepState {
  status: StepStatus;
}

export type OnboardingSteps = Record<OnboardingStepId, StepState>;

const ROW_ID = "global";

function initialSteps(): OnboardingSteps {
  return Object.fromEntries(
    ONBOARDING_STEPS.map((id) => [id, { status: "pending" as StepStatus }]),
  ) as OnboardingSteps;
}

function parseSteps(raw: string | null): OnboardingSteps {
  if (!raw) return initialSteps();
  try {
    const parsed = JSON.parse(raw) as Partial<OnboardingSteps>;
    const steps = initialSteps();
    for (const id of ONBOARDING_STEPS) {
      const s = parsed[id];
      if (s && (s.status === "done" || s.status === "skipped" || s.status === "pending")) {
        steps[id] = { status: s.status };
      }
    }
    return steps;
  } catch {
    return initialSteps();
  }
}

function isValidStep(id: string): id is OnboardingStepId {
  return (ONBOARDING_STEPS as readonly string[]).includes(id);
}

export class OnboardingError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
  }
}

export class OnboardingService {
  readonly #db: Kysely<Db>;

  constructor(db: Kysely<Db>) {
    this.#db = db;
  }

  /** Current wizard state; creates the durable row on first read. */
  async getState(): Promise<{ steps: OnboardingSteps; complete: boolean }> {
    let [row] = await this.#db
      .selectFrom("onboarding_state")
      .select("steps")
      .where("id", "=", ROW_ID)
      .execute();
    if (!row) {
      await this.#db
        .insertInto("onboarding_state")
        .values({
          id: ROW_ID,
          steps: JSON.stringify(initialSteps()),
          updatedAt: new Date().toISOString(),
        })
        .onConflict((oc) => oc.column("id").doNothing())
        .execute();
      [row] = await this.#db
        .selectFrom("onboarding_state")
        .select("steps")
        .where("id", "=", ROW_ID)
        .execute();
    }
    const steps = parseSteps(row?.steps ?? null);
    return { steps, complete: this.isComplete(steps) };
  }

  /**
   * Mark one step done or skipped. Unknown ids are rejected with a
   * product-facing message; already-finished steps stay finished (resuming a
   * finished step is a no-op, not an error). Skipping is only for optional
   * steps — required steps must be completed.
   */
  async setStep(
    stepId: string,
    action: "complete" | "skip",
  ): Promise<{ steps: OnboardingSteps; complete: boolean }> {
    if (!isValidStep(stepId)) {
      throw new OnboardingError(
        `"${stepId}" is not an onboarding step. Open Setup to see the available steps.`,
        404,
      );
    }
    if (action === "skip" && !OPTIONAL_STEPS.includes(stepId)) {
      throw new OnboardingError(
        `${LABELS[stepId]} is required and cannot be skipped. Finish it to continue setup.`,
        400,
      );
    }
    const current = await this.getState();
    const steps = current.steps;
    if (steps[stepId].status !== "pending") {
      // Already done or skipped — durable, idempotent no-op.
      return current;
    }
    const next: OnboardingSteps = {
      ...steps,
      [stepId]: { status: action === "skip" ? "skipped" : "done" },
    };
    if (
      stepId === "final-health" &&
      ONBOARDING_STEPS.some((s) => s !== "final-health" && next[s].status === "pending")
    ) {
      throw new OnboardingError(
        "Finish the earlier setup steps before running the final health check.",
        409,
      );
    }
    await this.#db
      .updateTable("onboarding_state")
      .set({ steps: JSON.stringify(next), updatedAt: new Date().toISOString() })
      .where("id", "=", ROW_ID)
      .execute();
    return { steps: next, complete: this.isComplete(next) };
  }

  /** Completion requires every step done or skipped — nothing pending. */
  isComplete(steps: OnboardingSteps): boolean {
    return ONBOARDING_STEPS.every((s) => steps[s].status !== "pending");
  }
}

/** Steps an operator may legitimately skip during guided setup. */
export const OPTIONAL_STEPS: readonly OnboardingStepId[] = [
  "download-engines",
  "indexers",
  "metadata",
  "vpn-policy",
];

export const LABELS: Record<OnboardingStepId, string> = {
  administrator: "Administrator account",
  storage: "Storage location",
  libraries: "Libraries",
  "download-engines": "Download engines",
  indexers: "Indexers",
  metadata: "Metadata providers",
  "vpn-policy": "VPN policy",
  "final-health": "Final health check",
};
