# Phase 3b — Acquisition Intelligence (comparison, private trackers, VPN)

Second subphase of Phase 3 (bounded). Owner phase for stories: 2, 5, 6, 7, 8, 31, 32.
Depends on: Phase 3a. Enables: Phase 4.

## Scope
Movies automation module (monitoring, quality profiles); release-comparison deep module (quality, size, seeders, proper/repack) applied before every grab; interactive search API + manual pick; failed-download handling (blacklist + auto re-search); private-tracker support as per-tracker plugins/config with announce-URL safety and seed/ratio goals; VPN manager (OpenVPN + WireGuard) with per-download-client tunnel binding and kill-switch enforcement.

## Non-goals
Import/rename (Phase 4); any tracker-specific logic in core (forbidden by ADR-015); polished VPN UX beyond functional binding.

## Contracts
- `dev.tantalar.capability.release-comparer` (built-in provides; replaceable), `dev.tantalar.capability.vpn-binding`.
- Grab path: wanted item → candidate releases → comparison verdict event → grab decision (auto or interactive) → client dispatch. Every step is an event.

## Data model changes
Plugin-owned: `movies`, `quality_profiles`, `blacklist`, `tracker_rules`, `seed_goals`, `vpn_profiles`, `client_bindings`, `grab_decisions`.

## Security constraints
Announce-URL guard: announce must match the tracker plugin's declared host patterns; passkeys never logged. Kill switch: clients bound to a tunnel are stopped and grabs paused before traffic may fall back to the default route; ordering tested.

## Acceptance criteria (exit)
Monitored movie auto-grabs a qualifying release end-to-end on fixtures; comparison engine passes its behavior suite; failed import blacklists and re-searches; a private-tracker fixture enforces announce safety and seed goals; kill-switch test shows zero leak window in the mocked network namespace.

## Test plan
Behavior-level unit suite for the comparison engine (deep module, external behavior only); integration for the full decision chain; mocked-namespace VPN routing/kill-switch tests; private-tracker announce-guard fuzz tests.

## Rollback / migration notes
Comparison verdicts persisted in `grab_decisions` so behavior changes are auditable historically; VPN disable returns clients to direct binding explicitly.

## MCP surface (owned here)
Movies automation and interactive-search MCP tools (mutations opt-in + scoped). VPN and private-tracker internals stay unexposed in v1. See [mcp-server.md](../mcp-server.md).

## Exit evidence
Green suites, event-log coverage for every new decision point, docs, reviewer acceptance.

## Phase 3B progress (implemented; completed by Phase 3C)

Status: download clients, comparison engine, grab-decision pipeline,
private-tracker safety, and the VPN manager are implemented and green.
The remaining automation scope (series + movies plugins, end-to-end fixture
pipeline) was completed under Phase 3C — see below and
phase-3c-automation.md.

### Contracts (packages/contracts/src/index.ts)
- Capability names: `dev.tantalar.capability.download-client`,
  `release-comparer`, `tracker.rules`, `vpn-binding` (indexer already 3a).
- Event types: `comparison.verdict`, `grab.decision`, `client.dispatch`,
  `download.queued|progress|completed|failed`, `blacklist.added`,
  `tunnel.health.changed`.
- Neutral schemas: `DownloadRequest` / `DownloadState` / `DownloadStatus`
  with `validateDownloadRequest` and `DownloadClientError`;
  `QualityProfile` / `CandidateRelease` / `ComparisonVerdict` plus
  `parseQualityLabel` and `isProperOrRepack`; tracker-neutral
  `TrackerAnnounceQuery` / `TrackerAnnounceVerdict` / `SeedGoal`;
  `VpnProfile` / `ClientBinding` / `TunnelState`.

### Plugins (all first-party, all out-of-process over the public contract)
- `plugins/fixture-download-client`: fixture NZB+torrent client; normalized
  state machine queued→downloading→completed with failure/cancel/retry paths
  driven by config; emits progress/completed/failed events with correlationId;
  idempotent adds; deterministic `advance` test surface.
- `plugins/qbittorrent`: adapter onto the qBittorrent WebUI API v2
  (`mapQbitState` → normalized states); injectable transport with an
  in-process memory mode so CI needs no real instance or network.
- `plugins/sabnzbd`: adapter onto the SABnzbd JSON API (`mapSabState`);
  NZB-only by contract; api key confined to the transport layer and proven
  absent from event payloads.
- `plugins/fixture-tracker`: owns ALL tracker-specific logic per ADR-0015 —
  announce-URL guard against declared host patterns (subdomain-suffix match;
  passkeys never echoed) and config-driven seed/ratio goals.
- `plugins/vpn-manager`: OpenVPN + WireGuard profiles, per-client tunnel
  binding, explicit unbind (VPN-disable path), and a FAIL-CLOSED kill switch:
  any health transition away from healthy blocks every bound client before
  anything may fall back to the default route; dispatch is allowed only on
  explicit `healthy`. Network manipulation sits behind a `NetControl` seam.

### Core acquisition module (apps/server/src/acquisition/)
- `comparer.ts`: built-in, replaceable release-comparison deep module
  (blacklist, size limit, seeder minimum, quality rank, proper/repack
  preference); returns structured verdicts with rejection reasons.
- `pipeline.ts`: grab path where every step is an immutable event —
  comparison verdict → grab decision (auto or interactive pick) → client
  dispatch → queued; consults the tracker plugin for announce safety before
  deciding, and the vpn-binding capability BEFORE any client dispatch
  (kill-switch block traced as `tunnel.health.changed` with no dispatch or
  queued event). Failed downloads blacklist via `handleFailure` and are
  rejected in later comparisons as `blacklisted_release`.

### Tests (tests/phase3b-acquisition.test.ts)
Comparison behavior suite; fixture client state machine incl. failure,
cancellation, retry; qBittorrent + SABnzbd end-to-end against memory
transports incl. SABnzbd torrent rejection and secret redaction (asserted
against the exact configured key via a single shared constant); pipeline
auto-grab, interactive pick (+ out-of-set rejection), no-qualifier block,
blacklist flow; tracker announce guard with hostile-host fuzz cases and
passkey-leak scan; VPN binding/unbind, fail-closed gate matrix
(unreported/degraded blocked, healthy allowed), kill-switch block-then-resume
with zero-dispatch assertion AND the gate bound to the actual download-client
plugin id (regression for round-1 review defect 1); kill-switch ORDERING test
driving `createVpnHandlers` with a recording `NetControl`, asserting `block`
fires for the bound client first and that unbind happens only via explicit
operator action (defect 3); conformance suites for all five new plugins.
No real trackers, usenet providers, or external downloads anywhere.

### Full checks at time of writing
`pnpm typecheck` clean · `pnpm build` clean · `pnpm test` → 17 files /
127 passed / 1 skipped (Postgres CI-gated).

### Residual risks / notes
- Kill-switch network enforcement is seam-level: `NetControl` is exercised
  via its in-memory implementation plus a recording seam in tests; real
  namespace/routing integration is a deployment concern outside this card's
  fixture-only test constraint.
- The grab-pipeline kill-switch gate resolves the download client's plugin id
  (`clientProvider.pluginId`) as the binding identity — fixed in round-1
  review; the release indexerId is never used as a client identity.
- MCP movies/interactive-search tools remain unexposed until their owning
  surfaces exist; VPN and tracker internals stay unexposed per spec.
