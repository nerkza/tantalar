# Tantalar — Implementation Roadmap

Status: Draft v1 · 2026-08-22
Companion to: [PRD](../PRD.md) · [Architecture](architecture.md) · [Traceability](traceability.md) · [ADRs](adrs/) · [Phase plans](phases/)

Design package (Phase 0) is complete. Each roadmap phase below has a detailed plan under [`docs/phases/`](phases/); locked decisions live in [`docs/adrs/`](adrs/). Note: Phase 3 is split into bounded subphases 3a, 3b and 3c in the phase plans.

## Phase 0 — Foundations (done)

- [x] PRD complete and filed (Issue #1)
- [x] Repo created, monorepo layout agreed
- [x] Key decisions locked: TS end-to-end, React + Mantine, out-of-process plugins (gRPC), append-only event log, SQLite default, MIT
- [x] Technical design package: [architecture](architecture.md), [traceability](traceability.md), [phase plans](phases/), [ADRs 0001–0018](adrs/)

## Phase 1 — Core Kernel (implemented; pending reviewer acceptance)

Goal: a bootable server that mounts plugins and records everything they do.
Evidence: [phase-1-core-kernel.md](phases/phase-1-core-kernel.md) — 53 tests green on SQLite (`pnpm test`), typecheck clean, Postgres migration job in CI.

- [x] Plugin runtime: manifest parsing, mount/unmount, dependency declaration (`inject`), reversible registration
- [x] Service container: services resolvable from context; built-ins register through the same public contract
- [x] Typed event bus: acquisition / import / serve domains; subscribers, not globals
- [x] Append-only event log: every operation persisted; replay-safe read API
- [x] Layered config: defaults → profile → host → CLI; `--dump-config` prints effective tree; anything printed is patchable
- [x] Persistence: SQLite via ORM abstraction (Postgres-ready)
- [x] Scheduler: cron-like job dispatch available to plugins
- [x] Auth skeleton: admin accounts, session handling, API keys
- [x] Minimal HTTP API + WebSocket event feed
- [x] Process supervision: plugin crash isolation, restart policy

Exit criteria: a hello-world out-of-process plugin mounts, emits events, survives crash-restart, and its activity reconstructs from the event log.

## Phase 2 — Plugin SDK & Conformance

- [x] Public plugin contract (protobuf IDL) + TS SDK
- [x] Core auth-introspection capability in the public contract (validates API keys + scopes for plugins; consumed by the MCP server)
- [x] MCP server plugin (`dev.tantalar.plugin.mcp`): server shell, protocol conformance, generic surface (health, capability discovery, activity query, operation-status query, redacted effective-config inspection) — [MCP contract](mcp-server.md), [ADR-0018](adrs/0018-mcp-server-plugin.md)
- [x] Conformance test suite shipped publicly; CI runs it against first-party modules
- [x] Plugin packaging/install/disable via configuration only
- [x] Developer docs: first plugin in under 30 minutes — [guides/first-plugin.md](guides/first-plugin.md)

Exit criteria: an external developer can build, test, and install a working plugin without reading Tantalar source. Status: implemented — pending reviewer acceptance. See [phases/phase-2-plugin-sdk.md](phases/phase-2-plugin-sdk.md) for exit evidence.

## Phase 3 — Acquisition Modules (implemented; pending reviewer acceptance)

Evidence: [phase-3a-acquisition.md](phases/phase-3a-acquisition.md) · [phase-3b-acquisition.md](phases/phase-3b-acquisition.md) · [phase-3c-automation.md](phases/phase-3c-automation.md) — `pnpm test` 18 files / 138 passed / 1 skipped (Postgres CI-gated).

- [x] Indexer layer (plugin-based; Prowlarr-compatible indexer definitions evaluated — adapter-plugin only)
- [x] Download-client abstraction: NZB + torrent (qBittorrent/SAB first)
- [x] Series automation module (monitor, seasons/episodes, quality profiles)
- [x] Movies automation module
- [x] Release comparison engine (quality, size, seeders, proper/repack) — deep module, heavily tested
- [x] Interactive search; failed-download blacklist + re-search
- [x] Private-tracker support as per-tracker plugin/config (announce safety, seed goals)
- [x] VPN module: OpenVPN and WireGuard protocol support; bindable per download-client so traffic is routed (or killed) via tunnel — kill-switch behaviour on tunnel drop

MCP surface owned here (reads on; mutations off by default): search, request/queue, acquisition tools — added only once the capabilities above exist ([mcp-server.md](mcp-server.md)).

## Phase 4 — Library & Import (implemented; pending reviewer acceptance)

Evidence: [phase-4-library-import.md](phases/phase-4-library-import.md) — `pnpm test` 19 files / 147 passed / 1 skipped (Postgres CI-gated).

- [x] Post-processor: configurable rename/import schemes
- [x] Hardlink-first import with copy fallback
- [x] Quality upgrade replacement
- [x] Metadata + artwork (TMDB/TVDB)
- [x] Calendar view data

MCP surface owned here: library read tools (mutations opt-in + scoped) — [mcp-server.md](mcp-server.md).

## Phase 5 — Serving (implemented; pending reviewer acceptance)

Evidence: [phase-5-serving.md](phases/phase-5-serving.md) — `pnpm test` 21 files / 195 passed / 1 skipped (Postgres CI-gated); Playwright 17/17.

- [x] Library browsing API (Netflix-style data model: collections, continue-watching, resume points)
- [x] Direct play path (no ffmpeg in the hot path)
- [x] Transcode fallback: on-demand ffmpeg → HLS; session negotiation
- [x] Subtitles: embedded + external, SRT/ASS/PGS
- [x] Viewer accounts, watch history, per-viewer library visibility
- [x] Web player UI

MCP surface owned here: library browse resources and playback mutation tools (opt-in + scoped) — [mcp-server.md](mcp-server.md).

## Phase 6 — UI Polish & Theming (implemented; pending reviewer acceptance)

Evidence: [phase-6-ui-polish.md](phases/phase-6-ui-polish.md) — Playwright 17/17 (8 admin + 9 viewer); review round-1 defects (grid-pref clobber on theme save; unwired grid persistence) fixed and re-verified.

- [x] Admin UI (Mantine + TanStack Table): queue grids, wanted lists, history
- [x] Design-token/CSS-variable theming layer; settings-UI theme editor
- [x] Activity/Trajectory view: filter, search, reconstruct pipeline decisions from the event log
- [x] Full CSS-level customization hooks for both admin and player UIs

## Launch Workstreams (parallel, low priority)

- [ ] `marketing-site/` repo: Starlight marketing site + public wiki (out of scope for v1 product; separate future repository)
- [x] MIT LICENSE, contributing guide, security policy (+ code of conduct, support/release docs)
- [x] Single Docker image (built and exercised locally; CI publish job defined but not run — publishing approval-gated)
- [x] Compose examples (SQLite + PostgreSQL), health checks, backup/restore, SBOM + license/GPL gate, full CI pipeline
- [x] v1 acceptance evidence: [reviews/v1-acceptance-evidence.md](reviews/v1-acceptance-evidence.md)

## Standing Rules

- Every phase ends with: tests green, event-log coverage for new operations, docs updated.
- No privileged kernel: if a built-in module needs a core change, expose it through the plugin contract instead.
- Deep modules (release comparison, importer, event log) get behavior-level tests only.
