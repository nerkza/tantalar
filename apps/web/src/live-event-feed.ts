import { useEffect, useRef, useState } from "react";
import type { TrajectoryEvent } from "./api";

export type LiveFeedStatus = "connecting" | "live" | "reconnecting" | "unavailable";

export interface LiveEventFeedFilters {
  readonly typePrefix?: string;
  readonly subject?: string;
  readonly correlationId?: string;
}

export interface LiveEventFeedOptions {
  readonly enabled?: boolean;
  readonly limit?: number;
}

export function isTrajectoryEvent(value: unknown): value is TrajectoryEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return typeof event.eventId === "string"
    && typeof event.type === "string"
    && typeof event.occurredAt === "string"
    && typeof event.producer === "string"
    && Boolean(event.payload)
    && typeof event.payload === "object"
    && !Array.isArray(event.payload);
}

export function useLiveEventFeed(
  filters: LiveEventFeedFilters = {},
  options: LiveEventFeedOptions = {},
) {
  const enabled = options.enabled !== false;
  const limit = Number.isSafeInteger(options.limit) && Number(options.limit) > 0 ? Number(options.limit) : 1_000;
  const [events, setEvents] = useState<TrajectoryEvent[]>([]);
  const [status, setStatus] = useState<LiveFeedStatus>(enabled ? "connecting" : "unavailable");
  const seen = useRef(new Set<string>());

  useEffect(() => {
    setEvents([]);
    seen.current.clear();
    if (!enabled || typeof WebSocket === "undefined") {
      setStatus("unavailable");
      return;
    }

    let stopped = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | undefined;
    let attempts = 0;
    const connect = () => {
      if (stopped) return;
      setStatus(attempts === 0 ? "connecting" : "reconnecting");
      const url = new URL("/api/v1/events/feed", window.location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      if (filters.typePrefix) url.searchParams.set("typePrefix", filters.typePrefix);
      if (filters.subject) url.searchParams.set("subject", filters.subject);
      socket = new WebSocket(url);
      socket.onopen = () => {
        attempts = 0;
        setStatus("live");
      };
      socket.onmessage = (message) => {
        try {
          const event: unknown = JSON.parse(String(message.data));
          if (!isTrajectoryEvent(event) || (filters.correlationId && event.correlationId !== filters.correlationId)) return;
          if (seen.current.has(event.eventId)) return;
          seen.current.add(event.eventId);
          setEvents((current) => [event, ...current].slice(0, limit));
        } catch {
          // Ignore malformed feed frames at the browser trust boundary.
        }
      };
      socket.onclose = (event) => {
        if (stopped) return;
        if (event.code === 4401 || event.code === 4403) {
          setStatus("unavailable");
          return;
        }
        const delay = Math.min(5_000, 250 * 2 ** Math.min(attempts++, 5));
        reconnectTimer = window.setTimeout(connect, delay);
      };
      socket.onerror = () => socket?.close();
    };

    connect();
    return () => {
      stopped = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [enabled, filters.correlationId, filters.subject, filters.typePrefix, limit]);

  return { events, status };
}
