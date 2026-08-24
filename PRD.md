# Tantalar — Product Requirements Document

Status: Draft v1 · 2026-08-22
Owner: Lewis Cookson

## Problem Statement

Self-hosters run a fragmented stack to manage media: Plex for serving, Sonarr/Radarr for wanted-list automation, separate NZB and torrent downloaders, plus glue scripts. Each tool has its own database, config format, UI conventions, and failure modes. Plex in particular has degraded — its apps grow ads, account requirements, and forced changes while self-hosters lose control of their own libraries. Maintaining five loosely coupled services is a standing tax on every self-hoster.

## Solution

Tantalar is a single open-source, self-hosted web application that unifies library serving, wanted-list automation, indexer search, NZB and torrent acquisition, and post-download processing. It is built "everything is a module/plugin" from day one: core provides a plugin runtime, typed event bus, and append-only activity log; all functionality — including first-party Sonarr/Radarr-equivalents — registers through the same public contract third-party plugins use. Admins configure or replace any capability without touching core source.

The torrent and NZB download engines are embedded in the product and are core: Tantalar works end-to-end with no external downloader daemon. External daemons (for example qBittorrent or SABnzbd) are optional integrations only — adapter plugins that exist alongside, never underneath, the embedded engines.

Target user: technical self-hosters replacing their existing *arr + Plex stack.

## Guiding Principles

1. Everything is a plugin — no privileged kernel requiring patches. Built-in modules mount through the identical contract used by community plugins.
2. Every operation is traceable — append-only event log of searches, grabs, imports, upgrades, transcodes. Activity view supports filter/search/replay ("why did it grab this release?").
3. Direct-play first — transcode only when necessary.
4. The web UI is the app — no native clients in v1.
5. Boring, mature dependencies; reliability over novelty.

## User Stories

### Acquisition & Automation

1. As an admin, I want to add TV shows by name so that Tantalar tracks seasons/episodes automatically.
2. As an admin, I want movie monitoring with quality profiles so that upgrades happen hands-free.
3. As an admin, I want to connect multiple NZB providers with retention/API limits respected.
4. As an admin, I want torrent support for public trackers.
5. As an admin, I want private-tracker support with per-tracker rules, announce-URL safety, and seed/ratio goals.
6. As an admin, I want release comparison (quality, size, seeders, proper/repack flags) applied before grabbing.
7. As an admin, I want interactive search so I can manually pick a release.
8. As an admin, I want failed-download handling (blacklist + auto re-search).
9. As an admin, I want calendars showing upcoming releases per show/movie.

### Post-Processing & Library

10. As an admin, I want configurable rename/import schemes.
11. As an admin, I want hardlink-first importing with copy fallback.
12. As an admin, I want quality upgrades to replace existing files cleanly.
13. As an admin, I want broad format support at direct play: MKV/MP4/AVI containers; H.264/HEVC/AV1 video; AAC/AC3/DTS/TrueHD/Atmos audio passthrough; SRT/ASS/PGS subtitles.
14. As an admin, I want metadata and artwork from standard providers (TMDB/TVDB).

### Serving

15. As a viewer, I want a Netflix-style browsing experience of the shared library.
16. As a viewer, I want direct playback in-browser whenever the device supports the file.
17. As a viewer, I want automatic transcoding (HLS) when direct play fails, with quality options.
18. As a viewer, I want continue-watching, watch history, and resume points per user.
19. As a viewer, I want subtitle selection and external subtitle loading.
20. As a viewer, I want offline-friendly playback controls (seek, next episode autoplay).
21. As an admin, I want per-viewer sharing rules (library visibility limits).

### Platform

22. As an admin, I want single sign-on-free simple auth: admin accounts for management, viewer accounts for playback.
23. As a plugin developer, I want an out-of-process plugin API (any language) with service container, dependency injection, typed events, and reversible mount/unmount.
24. As an admin, I want plugins installable/disabled/swappable entirely via configuration.
25. As an admin, I want an Activity/Trajectory view reconstructing any pipeline operation from the event log.
26. As an admin, I want full CSS-level theming of both admin and player UIs, with basic theme/layout customization available in the settings UI.
27. As an admin, I want dense, customizable management views (queue grids, wanted lists, history tables).
28. As an admin, I want one-command deployment (single Docker image) with SQLite default and Postgres option.
29. As an admin, I want API keys and webhook events so other tools integrate with Tantalar.
30. As a plugin developer, I want plugin sandboxing so a crashing plugin cannot take down the server.
31. As an admin, I want VPN support (OpenVPN and WireGuard) so download-client traffic routes through a tunnel.
32. As an admin, I want a kill switch so downloads halt instead of leaking traffic when the tunnel drops.

## Implementation Decisions

### Architecture

- **Core kernel**: process supervision, config, database access, scheduler, typed event bus, service container with `inject`-style dependency declaration, reversible plugin mounting, auth, REST/WebSocket API surface.
- **Built-in modules** (mount via the same public plugin contract): Series automation, Movies automation, Indexer layer, embedded download engines (NZB + torrent — core, no external daemon required), VPN manager (OpenVPN/WireGuard; per-client tunnel binding with kill-switch), Post-processor/importer, Media library, Streaming/transcode server, Web admin UI, Player UI.
- **Plugin contract**: out-of-process over gRPC (or HTTP+protobuf fallback). Language-agnostic; crash-isolated via supervisor; resource-limited. Manifest declares services provided/events consumed.
- **Event log**: append-only, typed events across domains (acquisition / import / serve). Powers the Activity view, debugging, and audit. Replay-safe design inspired by DeepSeek Harness's session log.
- **Configuration composition**: layered config (defaults → profile → host → CLI overrides); `--dump-config` prints effective tree; anything printed is patchable.

### Stack

- TypeScript end-to-end. Node (LTS) runtime; Bun acceptable if it proves stable for ffmpeg orchestration.
- Frontend: React + **Mantine** component library + TanStack Table for data-dense grids. Design tokens/CSS variables layer from day one for theming.
- Transcoding: ffmpeg on demand; HLS output; direct play path bypasses ffmpeg entirely.
- Database: SQLite (default) with an ORM abstraction allowing Postgres.
- Packaging: single Docker image; bare-metal install documented but secondary.

### Supporting Properties

- Marketing site + public wiki: low priority, launch-phase. System choice: **Starlight** (Astro-based, md content, versioned docs, easy theming) — BookStack dropped.
- License: MIT — permissive, maximizes plugin-ecosystem adoption; no GPL dependencies in core.

## Testing Decisions

- Tests target external behavior of deep modules only: release-comparison engine, importer/rename logic, event log replay, plugin lifecycle (mount/unmount/crash recovery), transcode session negotiation, auth boundaries.
- Plugin contract gets a conformance test suite shipped publicly so third-party authors can test against the same harness CI uses.
- Integration tests simulate full pipelines (search → grab → download → import → serve) against fixture downloads, not real indexers.

## In Scope (v1)

- The complete all-in-one path: discover → monitor → search → select → embedded download → verify → import → serve → play.
- Embedded torrent and NZB engines as core; external downloader daemons as optional integration plugins only.
- Basic hardware-acceleration detection (VAAPI/NVDEC) for transcoding.

## Out of Scope (v1)

- Native mobile/TV apps (web player only).
- Public wiki/marketing site implementation (launch workstream, tracked separately).
- Disc image formats (ISO/BDMV) playback.
- Polished hardware-acceleration tuning UI: detection is in scope, tuning polish is not.
- Multi-server federation/sync.
- Request portal for non-admin users (Overseerr-style) — candidate for a v2 plugin.

## Further Notes

- Name rationale: Tantalar — invented, timeless, fast connotation, no known collisions.
- DeepSeek Harness is the explicit architectural inspiration for both "everything is a plugin" and the traceable-run philosophy.
- Private-tracker support must never hardcode tracker-specific logic in core; each tracker is itself a small plugin/config.
