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

/** Short human step label for known pipeline event types. */
export function stepLabel(type: string): string {
  switch (type) {
    case "dev.tantalar.event.indexer.searched":
      return "Searched indexers";
    case "dev.tantalar.event.comparison.verdict":
      return "Compared releases";
    case "dev.tantalar.event.release.decision.recorded":
      return "Assessed releases";
    case "dev.tantalar.event.grab.decision":
      return "Grab decision";
    case "dev.tantalar.event.dispatch.gate.checked":
      return "VPN gate checked";
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
    label: stepLabelForEvent(e),
    at: e.occurredAt,
    detail: summarizePayload(e),
  }));
  const types = new Set(chain.events.map((e) => e.type));
  const verdict = chain.events.find((e) => e.type === "dev.tantalar.event.comparison.verdict");
  const assessmentEvent = chain.events.find((e) => e.type === "dev.tantalar.event.release.decision.recorded");
  const decision = chain.events.find(
    (e) => e.type === "dev.tantalar.event.grab.decision",
  );
  const winner = (verdict?.payload as { winnerGuid?: string } | undefined)?.winnerGuid
    ?? (assessmentEvent?.payload as { winnerCandidateId?: string } | undefined)?.winnerCandidateId;
  const candidates = (verdict?.payload as { candidates?: Array<{ guid?: string; title?: string }> } | undefined)?.candidates;
  const winnerTitle = candidates?.find((candidate) => candidate.guid === winner)?.title ?? winner;
  const decidedGuid = (decision?.payload as { guid?: string; releaseId?: string; decided?: boolean; reason?: string } | undefined);
  const selectedId = decidedGuid?.releaseId ?? decidedGuid?.guid;
  const assessments = (assessmentEvent?.payload as {
    assessments?: Array<{
      candidateId?: string;
      title?: string;
      reasons?: Array<{ code?: string; message?: string }>;
    }>;
  } | undefined)?.assessments ?? [];
  const selectedAssessment = assessments.find((assessment) => assessment.candidateId === selectedId);
  const selectedTitle = candidates?.find((candidate) => candidate.guid === selectedId)?.title
    ?? selectedAssessment?.title;
  const selectedReasons = selectedAssessment?.reasons
    ?.map((reason) => reason.message ?? reason.code?.replaceAll("_", " "))
    .filter((reason): reason is string => Boolean(reason))
    .join("; ");
  const importDone = types.has("dev.tantalar.event.import.completed");

  let summary: string;
  if (decidedGuid?.decided) {
    const title = selectedTitle ?? winnerTitle ?? "selected release";
    if (selectedId && winner && selectedId !== winner) {
      summary = `Grabbed "${title}" because the operator selected an eligible lower-ranked release${selectedReasons ? `: ${selectedReasons}` : ""}.`;
    } else {
      summary = `Grabbed "${title}" because it won release comparison${selectedReasons ? `: ${selectedReasons}` : ""}`
        + (importDone ? ", and it imported successfully." : ".");
    }
  } else if (decidedGuid && decidedGuid.decided === false) {
    const reason = String(decidedGuid.reason ?? "no qualifying release");
    summary = `Nothing was grabbed: ${reason.replaceAll("_", " ")}.`;
  } else {
    summary = `${chain.events.length} related operations under this correlation.`;
  }

  const verified = chain.events.some((event) =>
    event.type === "dev.tantalar.event.download.progress"
    && ("verification" in event.payload || "crcWarnings" in event.payload));

  return {
    summary,
    steps,
    complete:
      types.has("dev.tantalar.event.grab.decision")
      && types.has("dev.tantalar.event.dispatch.gate.checked")
      && types.has("dev.tantalar.event.client.dispatch")
      && types.has("dev.tantalar.event.download.completed")
      && verified
      && importDone,
  };
}

function stepLabelForEvent(event: TrajectoryEvent): string {
  if (event.type === "dev.tantalar.event.dispatch.gate.checked") {
    return event.payload.allowed === false ? "VPN gate blocked" : "VPN gate passed";
  }
  if (event.type === "dev.tantalar.event.download.progress") {
    if (event.payload.recovered === true) return "Download recovered";
    if ("verification" in event.payload || "crcWarnings" in event.payload) return "Download verified";
  }
  return stepLabel(event.type);
}

function summarizePayload(e: TrajectoryEvent): string {
  const p = e.payload ?? {};
  if (e.type === "dev.tantalar.event.comparison.verdict") {
    const candidates = Array.isArray(p.candidates) ? p.candidates : [];
    const winner = candidates.find((value) => value && typeof value === "object"
      && (value as Record<string, unknown>).guid === p.winnerGuid) as Record<string, unknown> | undefined;
    const reasons = Array.isArray(p.reasons) ? p.reasons.map((reason) => String(reason).replaceAll("_", " ")) : [];
    return [
      `winner=${String(winner?.title ?? "none")}`,
      `candidates=${candidates.length}`,
      `rejected=${Array.isArray(p.rejected) ? p.rejected.length : 0}`,
      ...(reasons.length ? [`reasons=${reasons.join("; ")}`] : []),
    ].join(" ");
  }
  if (e.type === "dev.tantalar.event.release.decision.recorded" && Array.isArray(p.assessments)) {
    return p.assessments.map((value) => {
      const assessment = value && typeof value === "object" ? value as Record<string, unknown> : {};
      const reasons = Array.isArray(assessment.reasons)
        ? assessment.reasons.map((reason) => {
            const detail = reason && typeof reason === "object" ? reason as Record<string, unknown> : {};
            return String(detail.message ?? detail.code ?? "");
          }).filter(Boolean)
        : [];
      return `${String(assessment.title ?? "Release")}: ${assessment.accepted === true ? "accepted" : "rejected"}${reasons.length ? ` — ${reasons.join("; ")}` : ""}`;
    }).join(" | ");
  }
  const parts: string[] = [];
  for (const k of ["itemKey", "query", "winnerGuid", "guid", "clientId", "health", "downloadId", "path", "mode", "reason", "progressPercent"]) {
    if (p[k] !== undefined) parts.push(`${k}=${String(p[k])}`);
  }
  if (Array.isArray(p.candidates)) parts.push(`candidates=${p.candidates.length}`);
  if (Array.isArray(p.rejected)) parts.push(`rejected=${p.rejected.length}`);
  if (p.verification && typeof p.verification === "object") {
    const verification = p.verification as Record<string, unknown>;
    parts.push(`verified=${String(verification.verifiedPieces ?? "?")}/${String(verification.totalPieces ?? "?")}`);
  }
  return parts.join(" ");
}
