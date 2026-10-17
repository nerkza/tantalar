export const ONBOARDING_STEPS = [
  "administrator", "experience", "libraries", "acquisition", "metadata", "first-title", "playback", "final-health",
] as const;
export type OnboardingStepId = typeof ONBOARDING_STEPS[number];
export type OnboardingStepStatus = "pending" | "configured" | "done" | "skipped" | "failed";
export interface OnboardingStepState {
  status: OnboardingStepStatus;
  detail?: string;
  checkedAt?: string;
}
export interface OnboardingState {
  version: 2;
  steps: Record<OnboardingStepId, OnboardingStepState>;
  currentStep: OnboardingStepId;
  mediaEnabled: boolean;
  acquisitionMode: "none" | "usenet" | "torrent";
  titleFileId: string | null;
  metadataQuery: string;
  releaseTarget?: { kind: "movie" | "series"; id: string; episodeKey?: string } | null;
  downloadJobId?: string | null;
  complete: boolean;
}
/** Only these non-secret choices may be saved in a setup draft. */
export type OnboardingPreferences = Partial<Pick<OnboardingState,
  "currentStep" | "mediaEnabled" | "acquisitionMode" | "titleFileId" | "metadataQuery" | "releaseTarget" | "downloadJobId"
>>;
