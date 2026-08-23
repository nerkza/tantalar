# Phase 3a — Acquisition Foundations (indexers + download clients)

First subphase of Phase 3 (bounded). Owner phase for stories: 1, 3, 4 (and the plumbing for 5–8).
Depends on: Phase 2. Enables: Phase 3b.

## Scope
Indexer layer as plugins (Prowlarr-compatible definition format evaluated; card for the evaluation outcome recorded in this doc's exit evidence); NZB provider support with retention/API-limit respect; torrent download-client abstraction with qBittorrent and SABnzbd client plugins; series automation skeleton: add-by-name via metadata provider, season/episode tracking, wanted-list generation and grab dispatch through the downloader abstraction. All built-ins mount via the public plugin contract.

## Non-goals
Release comparison scoring, interactive search, blacklist/re-search, private trackers, VPN (all Phase 3b); movies automation (3b); importing (Phase 4).

## Contracts
- `dev.tantalar.capability.indexer` (search, parse, limits), `dev.tantalar.capability.download-client` (add, status, remove), grab-request events in the acquisition domain.
- Download decisions emit `*.searched`, `*.release.grabbed`, `*.download.progress`, `*.download.completed` events.

## Data model changes
Plugin-owned: `series`, `seasons`, `episodes`, `wanted_items`, `download_mappings`, `indexer_config`, `download_client_config`.

## Security constraints
Indexer/download-client credentials env-or-config secrets, redacted in dumps; announce/passkey data never logged or emitted in event payloads.

## Acceptance criteria (exit)
Add a show by name against a fixture metadata provider; wanted episodes generate searches against fixture indexers; grabs dispatch to fixture download clients; full event chain reconstructs from the log. No live indexer needed (fixtures only).

## Test plan
Contract tests for indexer/client plugins via the conformance suite; integration pipeline search→grab→download against fixtures; limit-respect tests (retention window, API rate).

## Rollback / migration notes
Additive plugin-owned tables; disabling plugins leaves data intact.

## MCP surface (owned here)
Search, request/queue, and acquisition MCP tools are added in this phase, only for capabilities that already exist. Reads on by default; mutating tools off by default and requiring explicit configuration plus operation-specific scopes. Schemas generated from this phase's canonical runtime schemas. Audit event per call. See [mcp-server.md](../mcp-server.md).

## Exit evidence

Fixture pipeline green, event-log coverage report, docs, reviewer acceptance.

### Phase 3A progress (implemented, pending reviewer acceptance)

Status: the indexer layer is implemented and green. The remaining 3A scope —
download-client plugins and the full search→grab→download fixture pipeline —
was completed in Phase 3B/3C (see phase-3b-acquisition.md). Series automation
skeleton landed with Phase 3C. MCP acquisition tools remain unexposed until
their owning surfaces exist (mcp-server.md).

### Indexer capability (implemented)

- **Contracts** (`packages/contracts/src/index.ts`): provider-neutral schemas for
  `dev.tantalar.capability.indexer` — `IndexerQuery` (automatic | interactive),
  `IndexedRelease`, `IndexerSearchResult`, `IndexerLimits`
  (maxSearchesPerWindow/windowMs/retentionDays), stable `IndexerErrorCode`s with
  an `IndexerError` class, plus validators (`validateIndexerQuery`,
  `validateIndexedRelease`). New event types: `dev.tantalar.event.indexer.searched`,
  `dev.tantalar.event.release.grabbed`.
- **Fixture plugin** (`plugins/fixture-indexer/`): first-party plugin speaking only
  the neutral schema over the public contract (ADR-0015). Supports automatic and
  interactive queries, normalized results, rolling-window rate limits, retention
  filtering (automatic mode drops releases older than `retentionDays`; interactive
  sees everything), structured errors, a per-search `indexer.searched` event with
  caller correlationId, and the testkit `conformance-probe` operation.
- **Tests**: `tests/phase3a-indexer.test.ts` — schema validation, out-of-process
  automatic/interactive searches, rate-limit + retention respect, limits reporting,
  parse normalization + error paths, event-log tracing by correlationId,
  no credential/passkey material in event payloads, and the published conformance
  suite against the fixture.
- **Full checks at time of writing**: `pnpm typecheck` clean, `pnpm build` clean,
  `pnpm test` → 16 files / 98 passed / 1 skipped (Postgres CI-gated).

### Prowlarr-compatible definition format — evaluation outcome

Evaluated for direct adoption in core. Decision: **adapter-plugin only; not
adopted as a canonical format.**

- Prowlarr indexer definitions are YAML/JSON cards describing provider-specific
  request/response shapes (HTTP endpoints, XPath/JSONPath field extraction,
  login flows). Parsing them inside core would put tracker-specific logic in
  violation of ADR-0015.
- The neutral `IndexedRelease` schema covers what consumers need (guid, title,
  kind nzb/torrent, size, age, seeders, categories); mapping FROM a Prowlarr
  definition TO this schema is mechanical and belongs in a dedicated adapter
  plugin that loads user-supplied definition files and exposes the same
  `dev.tantalar.capability.indexer` capability.
- Risk noted: Prowlarr's category taxonomy is broader than our two numeric
  categories; adapter plugins own any vocabulary translation. No ADR change
  required — this follows existing locked decisions.
