import { useEffect, useRef } from "react";
import { api, type ClientIncidentKind, type ClientIncidentReport } from "../api";

const DEDUPE_MS = 60_000;
const DEFAULT_HEARTBEAT_MS = 1_000;
const DEFAULT_STALL_THRESHOLD_MS = 2_500;

export interface ClientIncidentReporterProps {
  enabled: boolean;
  appVersion?: string;
  heartbeatMs?: number;
  stallThresholdMs?: number;
}

function limited(value: string, length: number): string {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ").slice(0, length);
}

function fingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function visibleStallDuration(
  elapsedMs: number,
  heartbeatMs: number,
  thresholdMs: number,
  visible: boolean,
): number | null {
  if (!visible) return null;
  const delay = Math.max(0, elapsedMs - heartbeatMs);
  return delay >= thresholdMs ? Math.min(Math.round(delay), 120_000) : null;
}

function rejectionDetail(reason: unknown): { message: string; stack?: string } {
  if (reason instanceof Error) return { message: reason.message || reason.name, ...(reason.stack ? { stack: reason.stack } : {}) };
  if (typeof reason === "string") return { message: reason };
  if (reason === null || reason === undefined) return { message: "Unhandled promise rejection" };
  const name = typeof reason === "object" && "constructor" in reason
    ? String((reason as { constructor?: { name?: string } }).constructor?.name ?? "object")
    : typeof reason;
  return { message: `Unhandled promise rejection (${name})` };
}

export function ClientIncidentReporter({
  enabled,
  appVersion = "unknown",
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
  stallThresholdMs = DEFAULT_STALL_THRESHOLD_MS,
}: ClientIncidentReporterProps) {
  const reported = useRef(new Map<string, number>());

  useEffect(() => {
    if (!enabled) return;
    let resolvedAppVersion = appVersion;
    if (!resolvedAppVersion) {
      void api.version().then((version) => {
        resolvedAppVersion = version.version;
      }).catch(() => undefined);
    }

    const report = (
      kind: ClientIncidentKind,
      detail: { message: string; stack?: string; durationMs?: number },
    ) => {
      const route = limited(`${window.location.pathname}${window.location.hash}`, 240);
      const message = limited(detail.message || "Unknown browser error", 500);
      const stack = detail.stack ? limited(detail.stack, 4_000) : undefined;
      const fingerprintMessage = kind === "main-thread-stall" ? "main-thread-stall" : message;
      const incidentFingerprint = fingerprint(`${kind}|${route}|${fingerprintMessage}|${stack?.split("\n")[0] ?? ""}`);
      const now = Date.now();
      const lastSeen = reported.current.get(incidentFingerprint);
      if (lastSeen !== undefined && now - lastSeen < DEDUPE_MS) return;
      reported.current.set(incidentFingerprint, now);
      if (reported.current.size > 100) {
        const oldest = reported.current.keys().next().value as string | undefined;
        if (oldest) reported.current.delete(oldest);
      }

      const incident: ClientIncidentReport = {
        kind,
        fingerprint: incidentFingerprint,
        message,
        ...(stack ? { stack } : {}),
        route,
        appVersion: limited(resolvedAppVersion ?? "unknown", 80),
        occurredAt: new Date().toISOString(),
        ...(detail.durationMs !== undefined ? { durationMs: detail.durationMs } : {}),
      };
      void api.reportClientIncident(incident).catch(() => undefined);
    };

    const onWindowError = (event: ErrorEvent) => {
      report("window-error", {
        message: event.message || event.error?.message || "Unknown window error",
        ...(event.error instanceof Error && event.error.stack ? { stack: event.error.stack } : {}),
      });
    };
    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      report("unhandled-rejection", rejectionDetail(event.reason));
    };

    let previousHeartbeat = performance.now();
    const resetHeartbeat = () => {
      previousHeartbeat = performance.now();
    };
    const heartbeat = window.setInterval(() => {
      const now = performance.now();
      const durationMs = visibleStallDuration(
        now - previousHeartbeat,
        heartbeatMs,
        stallThresholdMs,
        document.visibilityState === "visible",
      );
      previousHeartbeat = now;
      if (durationMs !== null) {
        report("main-thread-stall", {
          message: `The browser main thread was unresponsive for about ${durationMs} ms`,
          durationMs,
        });
      }
    }, heartbeatMs);

    window.addEventListener("error", onWindowError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);
    document.addEventListener("visibilitychange", resetHeartbeat);
    return () => {
      window.clearInterval(heartbeat);
      window.removeEventListener("error", onWindowError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
      document.removeEventListener("visibilitychange", resetHeartbeat);
    };
  }, [appVersion, enabled, heartbeatMs, stallThresholdMs]);

  return null;
}
