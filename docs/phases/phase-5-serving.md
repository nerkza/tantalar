# Phase 5 — Serving: Exit Evidence (5A + 5B complete, review repairs applied)

Status: **Phase 5 complete — serving backend (5A), web player UI (5B), and the
six Phase 5 review repairs (task t_2bad15eb) implemented and tested.**

## Scope delivered in 5B (web player)

- `apps/web` — React 19 + Mantine 8 + TanStack Query app, hash routing,
  session-gated sign-in → library → player:
  - responsive library browsing: item grid, collections, continue-watching
    row with per-item progress; fail-closed server-side visibility honoured;
  - details via the player route; negotiation-driven playback:
    direct play (`<video src=/api/v1/stream/:fileId>`, byte-range seeking)
    or HLS fallback via hls.js with quality-level selection
    (ladder + Auto; no-op safe in direct mode);
  - embedded + external subtitle selection: SRT converted to VTT client-side;
    PGS/ASS listed but marked not renderable in the browser and stay off;
  - seek (native controls + accessible slider), resume on replay from the
    stored resume point, throttled progress reporting with the monotonic
    guard and explicit `allowRewind` on user seeks, watch history via
    completion at ≥95%;
  - autoplay next episode from series ordering (toggleable), viewer session
    gating and sign-out;
  - accessibility: keyboard-operable controls, ARIA roles/labels, live region
    for playback state, `role="alert"` errors.
- `e2e/viewer.spec.ts` + `e2e/global-setup.ts` — Playwright flows over a real
  mounted server: sign-in failure/success, visible-library boundaries,
  browsing, direct play (media decodes to readyState ≥ 1), HLS fallback with
  quality ladder, subtitle listing incl. non-renderable PGS, resume round-trip
  through the API, seek during HLS, next-episode autoplay. Fixtures are real
  locally generated ffmpeg media (testsrc/sine) plus a real MPEG-TS segment
  payload served by the HLS route (`segmentPayload` hook) — no copyrighted
  material.

## Scope delivered in 5A

- `plugins/serving` (`dev.tantalar.plugin.serving`,
  `dev.tantalar.capability.serving`):
  - library browsing with collections and continue-watching;
  - viewer accounts with per-library visibility, fail-closed (`set-viewer`,
    `authorize`);
  - browser capability negotiation → direct play vs HLS session
    (`isDirectPlayable` matrix over container × video × audio);
  - resume points + watch history per viewer, monotonic progress guard with
    explicit rewind escape; duration fallback to the previously recorded value;
  - subtitle inventory (embedded + external registration), never serving
    unregistered paths;
  - bounded transcode-session orchestration: global worker cap enforced at
    spawn, per-session idle timeout reap, hang watchdog kill, explicit cancel,
    startup cleanup of orphaned workers after a crash;
  - catalog/viewer/watch-state snapshot persistence via optional `stateFile`
    config so a remount after a simulated crash restores the catalog while
    transcode sessions stay ephemeral.
- `apps/server/src/serving.ts`: HTTP surface — `/api/v1/library` (+ resume,
  subtitles, history), `/api/v1/negotiate/:fileId`, `/api/v1/stream/:fileId`
  byte-range direct play (ffmpeg absent from this path), HLS
  manifest/playlist/segment routes, transcode-session open/cancel. Every route
  authenticates through the core guard; an `authorize` choke point runs before
  any metadata or byte leaves; range paths are re-checked against declared
  media roots.
- `packages/plugin-sdk`: control-channel error framing now carries stable
  `ServingError` codes so core maps them onto HTTP statuses (403/404/415/503).
- `packages/contracts`: `ServingError`, `isDirectPlayable`,
  `validateResumeUpdate`, playback/transcode event types.

## Review repairs (task t_2bad15eb, 2026-08-22)

The Phase 5 review (t_7b54a070) confirmed six defects. All six are repaired
with red-first regression tests in `tests/phase5-serving.test.ts`
("review repairs" blocks):

1. **Authorized subtitle-content route (P1).** New
   `GET /api/v1/library/subtitles/:trackId`, backed by the new
   `subtitle-content` capability operation. Content is registered at
   registration time (`subtitles[].content`) or supplied when an external
   track is uploaded; the route enforces per-viewer library visibility
   fail-closed before any text leaves the server. Unknown tracks 404,
   invisible libraries 403. Registered BEFORE the `:fileId`-scoped routes so
   the static segment is not swallowed as a fileId. The web player's
   `selectTrack` fetches from this route end-to-end.
2. **CSRF on all cookie-authenticated serving mutations (P1).** The core
   serving guard now enforces the double-submit token for POST/PUT/PATCH/DELETE
   on EVERY serving route whenever a session cookie authenticates the call —
   resume, negotiate, transcode-session open/cancel, subtitle registration.
   Bearer-token API-key calls and unauthenticated requests are unaffected.
3. **Viewer-bound HLS session authorization (P1).** `openSession` now stores
   the opening viewer's userId (empty ids are rejected), and the manifest,
   playlist, and segment routes verify the requesting viewer matches the
   session's bound user before touching or serving anything. A different
   session user gets 403; a closed session 404.
4. **HTTP-triggered real ffmpeg worker + real segment serving (P2).** New
   `POST /api/v1/hls/:sessionId/start` starts the session's transcode worker
   over HTTP. With `segmentsDir` configured, the plugin spawns a REAL ffmpeg
   process per session (args template `{{sessionIdPlaceholder}}` expands to
   `<segmentsDir>/<sessionId>`), creates the output directory, records the
   worker durably, and the segment route streams the actual produced
   MPEG-TS bytes from disk (name-sanitized, containment-checked) instead of a
   synthetic filler. The synthetic fallback remains only for fixture configs
   without `segmentsDir`.
5. **Durable orphan cleanup (P2).** Worker spawns now record `{sessionId,
   pid}` durably in the state-file snapshot; close/unmount removes the
   record; at mount the plugin SIGKILLs every pid recorded by a previous
   (crashed) instance before sweeping stale sessions. A kill -9 of the server
   no longer leaks orphaned ffmpeg processes.
6. **Named-viewer impersonation restricted (P2).** Only admin-role session
   users and scoped API-key callers may name an arbitrary viewer via
   `?viewerId=`/`body.userId`. Ordinary session users always act as their own
   userId; attempts to impersonate return 403.

## Security invariants

- Unauthenticated requests are 401 on every serving route.
- A viewer sees only permitted libraries across metadata, bytes, subtitles,
  playlists and segments (fail-closed when unknown).
- Cookie-authenticated mutations (core + serving) require the CSRF
  double-submit token.
- HLS sessions are bound to their opening viewer; only that viewer (or an
  admin / scoped API key naming them) can read the manifest, playlists, or
  segments.
- Named-viewer impersonation is limited to admins and scoped API keys.
- Direct play bypasses ffmpeg entirely; ranges cannot escape declared media
  roots (resolve + containment double-check); segment names are sanitized and
  served files must sit inside declared roots.
- Transcode workers are killed SIGKILL on session close/unmount/hang; worker
  pids are recorded durably so no orphaned worker survives a kill -9 restart
  cycle.

## Verification

- `pnpm run typecheck`: clean.
- `pnpm build`: clean.
- `pnpm test`: 20 files / 187 passed / 1 skipped (Postgres CI-gated),
  including `tests/phase5-serving.test.ts` (36 tests): format-matrix
  negotiation grid, direct-play byte ranges (206/416/suffix/open-ended),
  authorization boundaries, per-viewer browse/resume isolation, race guard +
  rewind, continue-watching ordering + completion, collections, subtitle
  inventory incl. external + format validation, subtitle CONTENT serving
  (external end-to-end, embedded, 404/403), CSRF enforcement on every
  cookie-authenticated serving mutation (+ positive control), viewer-bound
  HLS denial for foreign users, HTTP-triggered REAL ffmpeg transcode with
  real MPEG-TS segment bytes from disk, durable orphan-pid cleanup after a
  simulated crash remount, and named-viewer impersonation restrictions.
- `apps/web`: `pnpm --filter @tantalar/web test` (5 unit/integration tests:
  srt→vtt, engine attach/quality semantics, progress monotonic + rewind) and
  `pnpm --filter @tantalar/web build` (vite production build clean).
- `pnpm exec playwright test`: 9 passed — sign-in, visibility boundaries,
  direct play, HLS fallback + quality ladder, subtitle listing incl.
  non-renderable PGS, subtitle content route end-to-end through a signed-in
  browser context, resume round-trip, seek during HLS, next-episode autoplay.
- All media fixtures are locally generated with ffmpeg (testsrc/sine patterns)
  or plain byte blobs; the ffmpeg transcode worker is a fixture node
  subprocess. No real copyrighted media is used.

## Remaining after Phase 5

- Embedded SRT/ASS/PGS extraction from real containers (inventory contract is
  in place; extraction is a later milestone).
- Phase 6 UI polish stories (25–27).

No push or deploy performed.
