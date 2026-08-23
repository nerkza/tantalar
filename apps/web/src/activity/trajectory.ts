/**
 * Correlation-chain assembly for the Activity/Trajectory view (story 25).
 * Pure functions over event envelopes: group a replayed slice of the log
 * into per-correlationId chains and derive a human-readable decision
 * narrative ("why did it grab this release?").
 */

export interface TrajectoryEvent {
  readonly eventId: string;
  readonly type: string;
  readonly occurredAt: string;
  readonly producer: string;
  readonly subject?: string;
  readonly correlationId?: string;
  readonly causationId?: string;
  readonly payload: Record<string, unknown>;
}

export interface TrajectoryChain {
  /** The shared correlationId; uncorrelated events get their own id. */
  readonly correlationId: string;
  /** Events ordered by occurredAt then eventId (stable). */
  readonly events: readonly TrajectoryEvent[];
}

/** Stable ordering used everywhere in the trajectory UI. */
export function compareEvents(a: TrajectoryEvent, b: TrajectoryEvent): number {
  if (a.occurredAt !== b.occurredAt) return a.occurredAt < b.occurredAt ? -1 : 1;
  return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
}

/** Group events by correlationId; events without one form singleton chains. */
export function assembleChains(events: readonly TrajectoryEvent[]): TrajectoryChain[] {
  const byCorrelation = new Map<string, TrajectoryEvent[]>();
  for (const e of events) {
    const key = e.correlationId ?? `__uncorrelated__:${e.eventId}`;
    const list = byCorrelation.get(key);
    if (list) list.push(e);
    else byCorrelation.set(key, [e]);
  }
  return [...byCorrelation.entries()]
    .map(([correlationId, evts]) => ({ correlationId, events: [...evts].sort(compareEvents) }))
    .sort((a, b) => compareEvents(a.events[0]!, b.events[0]!));
}

const GRAB_STEP_ORDER = [
  "dev.tantalar.event.indexer.searched",
  "dev.tantalar.event.comparison.verdict",
  "dev.tantalar.event.grab.decision",
  "dev.tantalar.event.client.dispatch",
  "dev.tantalar.event.download.queued",
  "dev.tantalar.event.download.progress",
  "dev.tantalar.event.download.completed",
  "dev.tantalar.event.import.started",
  "dev.tantalar.event.import.completed",
] as const;

/** Short human step label for known pipeline event types. */
export function stepLabel(type: string): string {
  switch (type) {
    case "dev.tantalar.event.indexer.searched":
      return "Searched indexers";
    case "dev.tantalar.event.comparison.verdict":
      return "Compared releases";
    case "dev.tantalar.event.grab.decision":
      return "Grab decision";
    case "dev.tantalar.event.client.dispatch":
      return "Dispatched to client";
    case "dev.tantalar.event.download.queued":
      return "Queued";
    case "dev.tantalar.event.download.progress":
      return "Downloading";
    case "dev.tantalar.event.download.completed":
      return "Download complete";
    case "dev.tantalar.event.download.failed":
      return "Download failed";
    case "dev.tantalar.event.blacklist.added":
      return "Release blacklisted";
    case "dev.tantalar.event.import.started":
      return "Import started";
    case "dev.tantalar.event.import.completed":
      return "Import completed";
    case "dev.tantalar.event.import.failed":
      return "Import failed";
    default:
      return type.replace(/^dev\.tantalar\.event\./, "");
  }
}

export interface DecisionNarrative {
  /** One-line answer to "why did it grab this release?" */
  readonly summary: string;
  /** Ordered human steps reconstructed from the chain. */
  readonly steps: ReadonlyArray<{ id: string; label: string; at: string; detail: string }>;
  /** True when the chain contains the full grab→import arc. */
  readonly complete: boolean;
}

/**
 * Reconstruct a grab→import decision story from one correlation chain.
 * Unknown/foreign chains still produce a best-effort timeline.
 */
export function reconstructDecision(chain: TrajectoryChain): DecisionNarrative {
  const steps = chain.events.map((e) => ({
    id: e.eventId,
    label: stepLabel(e.type),
    at: e.occurredAt,
    detail: summarizePayload(e),
  }));
  const types = new Set(chain.events.map((e) => e.type));
  const verdict = chain.events.find((e) => e.type === "dev.tantalar.event.comparison.verdict");
  const decision = chain.events.find(
    (e) => e.type === "dev.tantalar.event.grab.decision",
  );
  const winner = (verdict?.payload as { winnerGuid?: string } | undefined)?.winnerGuid;
  const decidedGuid = (decision?.payload as { guid?: string; decided?: boolean; reason?: string } | undefined);
  const importDone = types.has("dev.tantalar.event.import.completed");

  let summary: string;
  if (decidedGuid?.decided && winner) {
    summary =
      `Grabbed "${winner}" because it won release comparison` +
      (decidedGuid.guid && decidedGuid.guid !== winner ? ` (operator picked ${decidedGuid.guid})` : "") +
      (importDone ? ", and it imported successfully." : ".");
  } else if (decidedGuid && decidedGuid.decided === false) {
    const reason = String(decidedGuid.reason ?? "no qualifying release");
    summary = `Nothing was grabbed: ${reason.replaceAll("_", " ")}.`;
  } else {
    summary = `${chain.events.length} related operations under this correlation.`;
  }

  // Order steps by pipeline semantics when they are all known grab steps,
  // otherwise keep chronological order.
  const allKnown = chain.events.every((e) => (GRAB_STEP_ORDER as readonly string[]).includes(e.type));
  const orderedSteps = allKnown
    ? [...steps].sort(
        (a, b) =>
          (GRAB_STEP_ORDER as readonly string[]).indexOf(labelToType(a.label)) -
          (GRAB_STEP_ORDER as readonly string[]).indexOf(labelToType(b.label)),
      )
    : steps;

  return {
    summary,
    steps: orderedSteps,
    complete: types.has("dev.tantalar.event.grab.decision") && importDone,
  };
}

function labelToType(label: string): string {
  for (const t of GRAB_STEP_ORDER) if (stepLabel(t) === label) return t;
  return label;
}

function summarizePayload(e: TrajectoryEvent): string {
  const p = e.payload ?? {};
  const parts: string[] = [];
  for (const k of ["itemKey", "query", "winnerGuid", "guid", "downloadId", "path", "mode", "reason", "progressPercent"]) {
    if (p[k] !== undefined) parts.push(`${k}=${String(p[k])}`);
  }
  return parts.join(" ");
}
