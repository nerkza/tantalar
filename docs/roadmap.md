# Tantalar — Implementation Roadmap

Status: Draft v1 · 2026-08-22
Companion to: [PRD](../PRD.md) · [Issue #1](https://github.com/nerkza/tantalar/issues/1)

## Phase 0 — Foundations (done)

- [x] PRD complete and filed (Issue #1)
- [x] Repo created, monorepo layout agreed
- [x] Key decisions locked: TS end-to-end, React + Mantine, out-of-process plugins (gRPC), append-only event log, SQLite default, MIT

## Phase 1 — Core Kernel

Goal: a bootable server that mounts plugins and records everything they do.

- [ ] Plugin runtime: manifest parsing, mount/unmount, dependency declaration (`inject`), reversible registration
- [ ] Service container: services resolvable from context; built-ins register through the same public contract
- [ ] Typed event bus: acquisition / import / serve domains; subscribers, not globals
- [ ] Append-only event log: every operation persisted; replay-safe read API
- [ ] Layered config: defaults → profile → host → CLI; `--dump-config` prints effective tree; anything printed is patchable
- [ ] Persistence: SQLite via ORM abstraction (Postgres-ready)
- [ ] Scheduler: cron-like job dispatch available to plugins
- [ ] Auth skeleton: admin accounts, session handling, API keys
- [ ] Minimal HTTP API + WebSocket event feed
- [ ] Process supervision: plugin crash isolation, restart policy

Exit criteria: a hello-world out-of-process plugin mounts, emits events, survives crash-restart, and its activity reconstructs from the event log.

## Phase 2 — Plugin SDK & Conformance

- [ ] Public plugin contract (protobuf IDL) + TS SDK
- [ ] Conformance test suite shipped publicly; CI runs it against first-party modules
- [ ] Plugin packaging/install/disable via configuration only
- [ ] Developer docs: first plugin in under 30 minutes

Exit criteria: an external developer can build, test, and install a working plugin without reading Tantalar source.

## Phase 3 — Acquisition Modules

- [ ] Indexer layer (plugin-based; Prowlarr-compatible indexer definitions evaluated)
- [ ] Download-client abstraction: NZB + torrent (qBittorrent/SAB first)
- [ ] Series automation module (monitor, seasons/episodes, quality profiles)
- [ ] Movies automation module
- [ ] Release comparison engine (quality, size, seeders, proper/repack) — deep module, heavily tested
- [ ] Interactive search; failed-download blacklist + re-search
- [ ] Private-tracker support as per-tracker plugin/config (announce safety, seed goals)

## Phase 4 — Library & Import

- [ ] Post-processor: configurable rename/import schemes
- [ ] Hardlink-first import with copy fallback
- [ ] Quality upgrade replacement
- [ ] Metadata + artwork (TMDB/TVDB)
- [ ] Calendar view data

## Phase 5 — Serving

- [ ] Library browsing API (Netflix-style data model: collections, continue-watching, resume points)
- [ ] Direct play path (no ffmpeg in the hot path)
- [ ] Transcode fallback: on-demand ffmpeg → HLS; session negotiation
- [ ] Subtitles: embedded + external, SRT/ASS/PGS
- [ ] Viewer accounts, watch history, per-viewer library visibility
- [ ] Web player UI

## Phase 6 — UI Polish & Theming

- [ ] Admin UI (Mantine + TanStack Table): queue grids, wanted lists, history
- [ ] Design-token/CSS-variable theming layer; settings-UI theme editor
- [ ] Activity/Trajectory view: filter, search, reconstruct pipeline decisions from the event log
- [ ] Full CSS-level customization hooks for both admin and player UIs

## Launch Workstreams (parallel, low priority)

- [ ] `marketing-site/` repo: Starlight marketing site + public wiki
- [ ] MIT LICENSE, contributing guide, security policy
- [ ] Single Docker image CI publish

## Standing Rules

- Every phase ends with: tests green, event-log coverage for new operations, docs updated.
- No privileged kernel: if a built-in module needs a core change, expose it through the plugin contract instead.
- Deep modules (release comparison, importer, event log) get behavior-level tests only.
