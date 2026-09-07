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
import { collectionPage, collectionFacets, mediaCollectionFields } from "./collection-page.js";
import { createReadStream, statSync, existsSync, realpathSync } from "node:fs";
import { resolve as pathResolve, sep } from "node:path";
import type { createMovieMetadataService } from "./movie-metadata.js";

export interface ServingDeps {
  enrichItems?: ReturnType<typeof createMovieMetadataService>["enrichItems"];
  artwork?: (fileId: string, variant: "poster" | "backdrop") => Promise<{ body: Buffer; contentType: string }>;
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
  resolvePath: (fileId: string) => string | null | Promise<string | null>;
  mediaRoots: readonly string[] | (() => readonly string[] | Promise<readonly string[]>);
  /** Resolve current durable grants before each serving operation. */
  resolveLibraryAccess?: (userId: string, isAdmin: boolean) => Promise<readonly string[]>;
  /**
   * Resolve a transcode session's HLS output file to its on-disk path.
   */
  resolveSegmentPath?: (sessionId: string, segment: string) => string | null;
  /** Root that contains all resolved HLS output files. */
  hlsRoot?: string;
  /**
   * Optional valid HLS segment payload provider for isolated tests.
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
  try {
    const real = realpathSync(pathResolve(p));
    if (!statSync(real).isFile()) throw status404;
    return real;
  } catch {
    throw status404;
  }
}

function isLocalAddress(value: unknown): boolean {
  const ip = String(value ?? "").replace(/^::ffff:/, "");
  if (ip === "::1" || ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe80:")) return true;
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10
    || (parts[0] === 172 && (parts[1] ?? 0) >= 16 && (parts[1] ?? 0) <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || parts[0] === 127;
}

function playbackClient(request: any) {
  const userAgent = String(request.headers?.["user-agent"] ?? "Unknown web client")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .slice(0, 160);
  return { client: userAgent, network: isLocalAddress(request.ip) ? "local" : "remote" } as const;
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
    if (deps.resolveLibraryAccess) {
      const isAdmin = auth.kind === "session" && auth.role === "admin" &&
        (!namedExplicitly || userId === auth.userId);
      const libraryIds = await deps.resolveLibraryAccess(userId, isAdmin);
      await deps.invoke("set-viewer", { userId, libraries: [...libraryIds] });
    }
    return { userId };
  };

  const mediaRoots = async (): Promise<readonly string[]> =>
    typeof deps.mediaRoots === "function" ? await deps.mediaRoots() : deps.mediaRoots;

  const isInMediaRoot = async (filePath: string): Promise<boolean> => {
    for (const root of await mediaRoots()) {
      try {
        if (isInside(realpathSync(pathResolve(root)), filePath)) return true;
      } catch {
        // Missing or unreadable roots cannot authorize a path.
      }
    }
    return false;
  };

  const isInHlsRoot = (filePath: string): boolean => {
    if (!deps.hlsRoot) return false;
    try {
      return isInside(realpathSync(pathResolve(deps.hlsRoot)), filePath);
    } catch {
      return false;
    }
  };

  const waitForHlsFile = async (filePath: string, timeoutMs = 12_000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (existsSync(filePath) && statSync(filePath).size > 0) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
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
    return guard(async () => {
      const result = await deps.invoke("browse", { userId: viewer.userId }) as { items: Array<{ fileId: string; itemKey: string; kind: string }> };
      const enriched = deps.enrichItems ? { ...result, items: await deps.enrichItems(result.items) } : result;
      if (request.query?.explorer !== "1") return enriched;
      // ponytail: providers enumerate authorized records; push paging into browse when the provider contract supports it.
      const page = collectionPage(enriched.items as Array<Record<string, unknown>>, request.query, {
        ...mediaCollectionFields, libraryId: item => item.libraryId,
      });
      return { ...page, facets: collectionFacets(enriched.items as Array<Record<string, unknown>>, mediaCollectionFields), collections: [], continueWatching: [] };
    }, reply);
  });

  app.get("/api/v1/library/:fileId/artwork/:variant", async (request: any, reply: any) => {
    const viewer = await actingViewer(request, reply, "serving.read");
    if (!viewer) return;
    const { fileId, variant } = request.params;
    if (variant !== "poster" && variant !== "backdrop") return reply.code(400).send({ error: "invalid artwork variant" });
    return guard(async () => {
      await deps.invoke("authorize", { userId: viewer.userId, fileId });
      try {
        if (!deps.artwork) throw new Error("artwork unavailable");
        const image = await deps.artwork(fileId, variant);
        // Recheck grants on every request, including after access is revoked.
        return reply.header("content-type", image.contentType).header("cache-control", "private, no-store").send(image.body);
      } catch {
        return reply.code(404).send({ error: "artwork unavailable" });
      }
    }, reply);
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
        ...playbackClient(request),
      })) as Record<string, unknown>;
      return out;
    }, reply);
  });

  // ---- Direct-play bytes (ffmpeg bypassed entirely on this path) ----

  app.get("/api/v1/stream/:fileId", async (request: any, reply: any) => {
    const viewer = await actingViewer(request, reply, "serving.read");
    if (!viewer) return;
    try {
      const sessionId = typeof request.query?.sessionId === "string" ? request.query.sessionId : null;
      if (sessionId) {
        const state = (await deps.invoke("session-state", { sessionId })) as Record<string, unknown>;
        if (state.closed || state.userId !== viewer.userId || state.fileId !== request.params.fileId) {
          return reply.code(403).send({ error: "playback session is not valid for this stream" });
        }
        await deps.invoke("session-touch", { sessionId });
      }
      // Authorization choke point BEFORE any byte is read.
      await deps.invoke("authorize", { userId: viewer.userId, fileId: request.params.fileId });
      const real = assertContained(await deps.resolvePath(String(request.params.fileId)));
      // Defense in depth: containment against declared roots, again.
      const contained = await isInMediaRoot(real);
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
          ...playbackClient(request),
        }),
      reply,
    );
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

  const closeOwnedSession = async (request: any, reply: any) => {
    const state = await authorizedSession(request, reply);
    if (!state) return;
    return guard(() => deps.invoke("close-session", {
      sessionId: request.params.sessionId,
      reason: "client_close",
    }), reply);
  };

  app.delete("/api/v1/transcode-session/:sessionId", closeOwnedSession);
  app.delete("/api/v1/playback-session/:sessionId", closeOwnedSession);

  app.post("/api/v1/playback-session/:sessionId/touch", async (request: any, reply: any) => {
    const state = await authorizedSession(request, reply);
    if (!state) return;
    const body = (request.body ?? {}) as Record<string, unknown>;
    return guard(() => deps.invoke("session-touch", {
      sessionId: request.params.sessionId,
      positionMs: body.positionMs,
      durationMs: body.durationMs,
    }), reply);
  });

  app.post("/api/v1/hls/:sessionId/start", async (request: any, reply: any) => {
    const state = await authorizedSession(request, reply);
    if (!state) return;
    return guard(async () => {
      if (!deps.resolveSegmentPath || !deps.hlsRoot) {
        return reply.code(503).send({ error: "HLS transcoding is not configured on this server" });
      }
      const source = await deps.resolvePath(String(state.fileId ?? ""));
      const realSource = source && existsSync(source) ? realpathSync(pathResolve(source)) : null;
      if (!realSource || !(await isInMediaRoot(realSource))) {
        return reply.code(404).send({ error: "media source is not available" });
      }
      const sessionId = String(request.params.sessionId);
      const playlistPath = deps.resolveSegmentPath(sessionId, "playlist.m3u8");
      if (!playlistPath || !isInside(pathResolve(deps.hlsRoot), pathResolve(playlistPath))) {
        return reply.code(503).send({ error: "HLS output path is not configured safely" });
      }
      const started = await deps.invoke("start-worker", { sessionId, inputPath: realSource });
      if (!(await waitForHlsFile(playlistPath))) {
        await deps.invoke("cancel-session", { sessionId }).catch(() => undefined);
        return reply.code(503).send({ error: "FFmpeg did not produce a playable HLS stream within 12 seconds" });
      }
      const realPlaylist = realpathSync(pathResolve(playlistPath));
      if (!isInHlsRoot(realPlaylist)) {
        await deps.invoke("cancel-session", { sessionId }).catch(() => undefined);
        return reply.code(503).send({ error: "FFmpeg produced output outside the configured HLS directory" });
      }
      return { ...(started as Record<string, unknown>), ready: true };
    }, reply);
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
      const playlistPath = deps.resolveSegmentPath?.(String(request.params.sessionId), "playlist.m3u8") ?? null;
      if (playlistPath) {
        const real = existsSync(playlistPath) ? realpathSync(pathResolve(playlistPath)) : null;
        if (real && isInHlsRoot(real)) {
          reply
            .code(200)
            .header("Content-Type", "application/vnd.apple.mpegurl")
            .header("Content-Length", String(statSync(real).size));
          return reply.send(createReadStream(real));
        }
        return reply.code(503).send({ error: "HLS playlist is not ready; start the transcode session first" });
      }
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
      // Serve only a real worker output or an explicitly supplied valid test
      // payload. Never report filler bytes as playable MPEG-TS.
      const segmentName = String(request.params.segment);
      if (!/^[A-Za-z0-9._-]+$/.test(segmentName)) {
        return reply.code(400).send({ error: "invalid segment name" });
      }
      const filePath = deps.resolveSegmentPath?.(String(request.params.sessionId), segmentName) ?? null;
      if (filePath) {
        const real = existsSync(filePath) ? realpathSync(pathResolve(filePath)) : null;
        const contained = real ? isInHlsRoot(real) : false;
        if (contained && real) {
          reply
            .code(200)
            .header("Content-Type", "video/mp2t")
            .header("Content-Length", String(statSync(real).size));
          return reply.send(createReadStream(real));
        }
        return reply.code(404).send({ error: "segment not yet available" });
      }
      if (deps.segmentPayload) {
        reply.header("Content-Type", "video/mp2t");
        return deps.segmentPayload();
      }
      return reply.code(503).send({ error: "HLS transcoding is not configured on this server" });
    }, reply);
  });
}
