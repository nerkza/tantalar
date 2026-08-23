/**
 * Phase 5A HTTP serving surface: library browsing, negotiation, direct-play
 * byte-range streaming, HLS manifest/segment serving, subtitles, resume
 * points, watch history.
 *
 * Security model:
 *  - every route authenticates through the core auth guard (session cookie
 *    or scoped API key) before anything else happens;
 *  - before any metadata or byte leaves the server, an `authorize` call to
 *    the serving capability enforces per-library visibility (fail-closed);
 *  - range requests are resolved to a registered media path and re-checked
 *    against declared media roots, so a range can never escape them.
 */
import type { FastifyInstance } from "fastify";
import { createReadStream, statSync, existsSync } from "node:fs";
import { resolve as pathResolve, sep } from "node:path";

export interface ServingDeps {
  /** Invoke the dev.tantalar.capability.serving provider. */
  invoke: (operation: string, payload: Record<string, unknown>) => Promise<unknown>;
  /**
   * Core auth guard (same semantics as the main route table): sends 401/403
   * itself and returns null when the caller may not proceed.
   */
  requireAuth: (
    request: unknown,
    reply: unknown,
    requiredScope?: string,
  ) => Promise<{ kind: "session" | "apiKey"; scopes: string[]; userId?: string; role?: string } | null>;
  /**
   * Resolve a registered fileId to its on-disk path. The mapping lives in
   * core so the plugin never handles filesystem paths; core re-checks
   * containment against mediaRoots after resolution.
   */
  resolvePath: (fileId: string) => string | null;
  mediaRoots: readonly string[];
  /**
   * Resolve a transcode session's segment to its on-disk path. Returns null
   * when the server has no segments dir configured (synthetic fallback).
   */
  resolveSegmentPath?: (sessionId: string, segment: string) => string | null;
  /**
   * Optional HLS segment payload provider (e2e/testing hook). When absent the
   * synthetic sync-byte filler is served — production always transcodes.
   */
  segmentPayload?: () => Buffer;
}

const RANGE_RE = /^bytes=(\d*)-(\d*)$/;

function parseRange(header: unknown, size: number): { start: number; end: number } | "invalid" | null {
  if (typeof header !== "string" || header.length === 0) return null;
  const m = RANGE_RE.exec(header);
  if (!m) return "invalid";
  if (m[1] === "" && m[2] === "") return "invalid";
  let start: number;
  let end: number;
  if (m[1] === "") {
    // suffix range: last N bytes
    end = size - 1;
    start = Math.max(0, size - Number(m[2]));
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size || start < 0)
    return "invalid";
  return { start, end };
}

function isInside(root: string, child: string): boolean {
  return child === root || child.startsWith(root + sep);
}

/** Resolve + existence-check a fileId path; throws with an HTTP status. */
function assertContained(p: string | null): string {
  const status404 = Object.assign(new Error("not found"), { statusCode: 404 });
  if (!p) throw status404;
  const real = pathResolve(p);
  if (!existsSync(real)) throw status404;
  return real;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function registerServingRoutes(app: FastifyInstance, deps: ServingDeps): void {
  /**
   * Authenticate + resolve the acting viewer. Session users act ONLY as
   * themselves — acting for an arbitrary named viewer is restricted to
   * admin-role session users and scoped API-key callers (who MUST name one).
   * Returns null only when a reply was already sent (401/403/400).
   */
  const actingViewer = async (
    request: any,
    reply: any,
    scope?: string,
  ): Promise<{ userId: string } | null> => {
    const auth = await deps.requireAuth(request, reply, scope);
    if (!auth) return null;
    const explicit =
      (request.query ?? {})["viewerId"] ?? ((request.body as Record<string, unknown> | undefined) ?? {})["userId"];
    const namedExplicitly = typeof explicit === "string" && explicit.length > 0;
    const isPrivileged = auth.kind === "apiKey" || auth.role === "admin";
    if (namedExplicitly && !isPrivileged) {
      await reply.code(403).send({ error: "only admins and scoped API keys may act as a named viewer" });
      return null;
    }
    // Scoped API keys MUST name one; privileged sessions may act for a named
    // viewer; ordinary sessions always act as themselves.
    let userId: string | undefined;
    if (namedExplicitly) {
      userId = explicit as string;
    } else if (auth.kind === "apiKey") {
      userId = undefined;
    } else {
      userId = auth.userId;
    }
    if (!userId) {
      await reply.code(400).send({ error: "viewerId required for api-key access" });
      return null;
    }
    return { userId };
  };

  const errStatus = (err: unknown): number => {
    const e = err as { code?: string; statusCode?: number; message?: string };
    if (typeof e?.statusCode === "number") return e.statusCode;
    // Plugin errors cross the control channel as plain Error messages, so
    // match stable ServingError codes out of the message text too.
    const msg = e?.message ?? "";
    if (/\bforbidden\b/.test(msg)) return 403;
    if (/\bnot_found\b|unknown session|unknown fileId|not active/.test(msg)) return 404;
    if (/\bsession_limit\b/.test(msg)) return 503;
    if (/\bno_worker\b/.test(msg)) return 503;
    switch (e?.code) {
      case "not_found":
        return 404;
      case "forbidden":
        return 403;
      case "invalid_request":
        return 400;
      case "unsupported_format":
        return 415;
      case "session_limit":
      case "no_worker":
        return 503;
      default:
        break;
    }
    if (/must be|required/.test(msg)) return 400;
    return 500;
  };

  /** Run a capability-backed handler; map ServingError codes onto HTTP. */
  const guard = async (fn: () => Promise<unknown>, reply: any) => {
    try {
      return await fn();
    } catch (err) {
      return reply.code(errStatus(err)).send({ error: (err as Error).message });
    }
  };

  const serveFileBytes = async (request: any, reply: any, filePath: string) => {
    const stat = statSync(filePath);
    const size = stat.size;
    const range = parseRange(request.headers.range, size);
    if (range === "invalid") {
      reply.code(416).header("Content-Range", `bytes */${size}`);
      return { error: "range not satisfiable" };
    }
    if (range) {
      reply
        .code(206)
        .header("Content-Type", "video/mp4")
        .header("Accept-Ranges", "bytes")
        .header("Content-Range", `bytes ${range.start}-${range.end}/${size}`)
        .header("Content-Length", String(range.end - range.start + 1));
      const stream = createReadStream(filePath, { start: range.start, end: range.end });
      return reply.send(stream);
    }
    reply
      .code(200)
      .header("Content-Type", "video/mp4")
      .header("Accept-Ranges", "bytes")
      .header("Content-Length", String(size));
    return reply.send(createReadStream(filePath));
  };

  // ---- Browsing / watch state ----

  app.get("/api/v1/library", async (request: any, reply: any) => {
    const viewer = await actingViewer(request, reply, "serving.read");
    if (!viewer) return;
    return guard(() => deps.invoke("browse", { userId: viewer.userId }), reply);
  });

  app.post("/api/v1/library/:fileId/resume", async (request: any, reply: any) => {
    const viewer = await actingViewer(request, reply, "serving.write");
    if (!viewer) return;
    const body = (request.body ?? {}) as Record<string, unknown>;
    return guard(
      () =>
        deps.invoke("set-resume", {
          userId: viewer.userId,
          fileId: request.params.fileId,
          positionMs: body.positionMs,
          durationMs: body.durationMs,
          allowRewind: body.allowRewind,
        }),
      reply,
    );
  });

  app.get("/api/v1/library/:fileId/resume", async (request: any, reply: any) => {
    const viewer = await actingViewer(request, reply, "serving.read");
    if (!viewer) return;
    return guard(
      () => deps.invoke("resume-point", { userId: viewer.userId, fileId: request.params.fileId }),
      reply,
    );
  });

  app.get("/api/v1/history", async (request: any, reply: any) => {
    const viewer = await actingViewer(request, reply, "serving.read");
    if (!viewer) return;
    return guard(() => deps.invoke("history", { userId: viewer.userId }), reply);
  });

  // ---- Capability negotiation ----

  app.post("/api/v1/negotiate/:fileId", async (request: any, reply: any) => {
    const viewer = await actingViewer(request, reply, "serving.write");
    if (!viewer) return;
    return guard(async () => {
      const out = (await deps.invoke("negotiate", {
        userId: viewer.userId,
        fileId: request.params.fileId,
        capabilities: request.body,
      })) as Record<string, unknown>;
      return out;
    }, reply);
  });

  // ---- Direct-play bytes (ffmpeg bypassed entirely on this path) ----

  app.get("/api/v1/stream/:fileId", async (request: any, reply: any) => {
    const viewer = await actingViewer(request, reply, "serving.read");
    if (!viewer) return;
    try {
      // Authorization choke point BEFORE any byte is read.
      await deps.invoke("authorize", { userId: viewer.userId, fileId: request.params.fileId });
      const real = assertContained(deps.resolvePath(String(request.params.fileId)));
      // Defense in depth: containment against declared roots, again.
      const contained = deps.mediaRoots.some((root) => isInside(pathResolve(root), real));
      if (!contained) return reply.code(403).send({ error: "path escapes declared media roots" });
      return await serveFileBytes(request, reply, real);
    } catch (err) {
      return reply.code(errStatus(err)).send({ error: (err as Error).message });
    }
  });

  // ---- Subtitles ----

  // NOTE: registered BEFORE /library/:fileId/subtitles so "subtitles" in the
  // second path segment is never swallowed as a :fileId parameter.
  app.get("/api/v1/library/subtitles/:trackId", async (request: any, reply: any) => {
    const viewer = await actingViewer(request, reply, "serving.read");
    if (!viewer) return;
    return guard(async () => {
      const out = (await deps.invoke("subtitle-content", {
        userId: viewer.userId,
        trackId: request.params.trackId,
      })) as { content?: string; format?: string };
      reply.header("Content-Type", "text/vtt; charset=utf-8");
      return out.content ?? "";
    }, reply);
  });

  app.get("/api/v1/library/:fileId/subtitles", async (request: any, reply: any) => {
    const viewer = await actingViewer(request, reply, "serving.read");
    if (!viewer) return;
    return guard(
      () =>
        deps.invoke("subtitle-inventory", {
          userId: viewer.userId,
          fileId: request.params.fileId,
        }),
      reply,
    );
  });

  app.post("/api/v1/library/:fileId/subtitles", async (request: any, reply: any) => {
    const viewer = await actingViewer(request, reply, "serving.write");
    if (!viewer) return;
    const body = (request.body ?? {}) as Record<string, unknown>;
    return guard(
      () =>
        deps.invoke("add-external-subtitle", {
          userId: viewer.userId,
          fileId: request.params.fileId,
          lang: body.lang,
          format: body.format,
          content: body.content,
        }),
      reply,
    );
  });

  // ---- Transcode sessions ----

  app.post("/api/v1/transcode-session", async (request: any, reply: any) => {
    const viewer = await actingViewer(request, reply, "serving.write");
    if (!viewer) return;
    const body = (request.body ?? {}) as Record<string, unknown>;
    return guard(
      () =>
        deps.invoke("open-session", {
          userId: viewer.userId,
          fileId: body.fileId,
          qualities: body.qualities,
          reason: body.reason,
        }),
      reply,
    );
  });

  app.delete("/api/v1/transcode-session/:sessionId", async (request: any, reply: any) => {
    const viewer = await actingViewer(request, reply, "serving.write");
    if (!viewer) return;
    return guard(() => deps.invoke("cancel-session", { sessionId: request.params.sessionId }), reply);
  });

  /**
   * Viewer-bound session authorization: the requesting session user (or
   * explicitly named viewer for privileged callers) must match the userId
   * the session was opened with. Returns the session state, or null after
   * sending 403/404.
   */
  const authorizedSession = async (request: any, reply: any): Promise<Record<string, unknown> | null> => {
    const viewer = await actingViewer(request, reply, "serving.read");
    if (!viewer) return null;
    const state = (await deps.invoke("session-state", {
      sessionId: request.params.sessionId,
    })) as Record<string, unknown>;
    if (state.closed) {
      return reply.code(404).send({ error: "session not active" });
    }
    if (state.userId !== viewer.userId) {
      return reply.code(403).send({ error: "session belongs to a different viewer" });
    }
    return state;
  };

  app.post("/api/v1/hls/:sessionId/start", async (request: any, reply: any) => {
    const state = await authorizedSession(request, reply);
    if (!state) return;
    return guard(() => deps.invoke("start-worker", { sessionId: request.params.sessionId }), reply);
  });

  app.get("/api/v1/hls/:sessionId/manifest.m3u8", async (request: any, reply: any) => {
    const state = await authorizedSession(request, reply);
    if (!state) return;
    return guard(async () => {
      await deps.invoke("session-touch", { sessionId: request.params.sessionId });
      const qualities = (state.qualities as string[]) ?? [];
      const lines = ["#EXTM3U", "#EXT-X-VERSION:3"];
      for (let i = 0; i < qualities.length; i++) {
        lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${(i + 1) * 1000000},RESOLUTION=${qualities[i]}`);
        lines.push(`${i}/playlist.m3u8`);
      }
      reply.header("Content-Type", "application/vnd.apple.mpegurl");
      return lines.join("\n") + "\n";
    }, reply);
  });

  app.get("/api/v1/hls/:sessionId/:quality/playlist.m3u8", async (request: any, reply: any) => {
    const state = await authorizedSession(request, reply);
    if (!state) return;
    return guard(async () => {
      await deps.invoke("session-touch", { sessionId: request.params.sessionId });
      const lines = [
        "#EXTM3U",
        "#EXT-X-VERSION:3",
        "#EXT-X-TARGETDURATION:4",
        "#EXTINF:4.0,",
        "seg0.ts",
        "#EXTINF:4.0,",
        "seg1.ts",
        "#EXT-X-ENDLIST",
      ];
      reply.header("Content-Type", "application/vnd.apple.mpegurl");
      return lines.join("\n") + "\n";
    }, reply);
  });

  app.get("/api/v1/hls/:sessionId/:quality/:segment", async (request: any, reply: any) => {
    const state = await authorizedSession(request, reply);
    if (!state) return;
    return guard(async () => {
      await deps.invoke("session-touch", { sessionId: request.params.sessionId });
      // Real segment bytes: when a transcode worker (real ffmpeg) has
      // produced the segment file under the configured segments dir, serve
      // it from disk. Only the synthetic fallback remains for fixture
      // configs without segmentsDir.
      const segmentName = String(request.params.segment);
      if (!/^[A-Za-z0-9._-]+$/.test(segmentName)) {
        return reply.code(400).send({ error: "invalid segment name" });
      }
      const filePath = deps.resolveSegmentPath?.(String(request.params.sessionId), segmentName) ?? null;
      if (filePath) {
        const contained = deps.mediaRoots.some(
          (root) => isInside(pathResolve(root), pathResolve(filePath)),
        );
        if (contained && existsSync(filePath)) {
          reply
            .code(200)
            .header("Content-Type", "video/mp2t")
            .header("Content-Length", String(statSync(filePath).size));
          return reply.send(createReadStream(filePath));
        }
        return reply.code(404).send({ error: "segment not yet available" });
      }
      // Synthetic segment payload — no copyrighted media ever served here.
      reply.header("Content-Type", "video/mp2t");
      return deps.segmentPayload ? deps.segmentPayload() : Buffer.alloc(188 * 7, 0x47);
    }, reply);
  });
}
