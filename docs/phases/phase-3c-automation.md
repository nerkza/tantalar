# Phase 3c — Automation & Release Decisions (completes Phase 3)

Final subphase of Phase 3 (bounded). Owner phase for stories: 1, 2, and the
end-to-end exit evidence for stories 3–8.
Depends on: Phase 3a + 3b. Completes: Phase 3. Enables: Phase 4.

## Scope
Series automation plugin (add-by-name, season/episode tracking, wanted list,
per-show quality profiles); movies automation plugin (monitoring, quality
profiles, acquisition tracking); end-to-end fixture pipeline covering search →
comparison → decision → grab → download lifecycle → failure → blacklist →
re-search; correlated event history for every step.

## Non-goals
Import/rename (Phase 4); MCP acquisition tools (unexposed until their owning
surfaces exist per mcp-server.md); any tracker-specific logic in core
(ADR-0015).

## Contracts
- `dev.tantalar.capability.automation.series`, `dev.tantalar.capability.automation.movies`
  (both first-party plugins over the public contract).
- New event types: `series.added`, `series.monitoring.changed`,
  `series.episode.searched`, `movie.added`, `movie.monitoring.changed`,
  `movie.scan.completed`, `movie.acquired`.
- The grab pipeline propagates the caller's correlationId into the
  DownloadRequest, so client-side lifecycle events (progress/completed/failed)
  reconstruct under the same correlation id as the grab chain.

## Data model changes
Plugin-owned in-process state (fixture-only in CI): series with monitored
seasons/episodes; monitored movies with quality profiles and acquired guid.
Persistent plugin tables arrive with their owning surfaces (Phase 4+).

## Acceptance criteria (exit)
Fixture pipelines add shows and movies, select or manually choose releases,
grab through NZB/torrent clients, handle failures, blacklist bad releases,
and re-search. Tests cover ranking boundaries, proper/repack, size, seeders,
quality upgrades, idempotency, failure recovery, and event reconstruction.

## Test plan (tests/phase3c-automation.test.ts)
Series plugin: add-by-name idempotency, season/episode creation, wanted-list
generation, monitoring toggle, event-traced episode scans. Movies plugin:
idempotent add, scan of unacquired monitored movies, mark-acquired
idempotency (same guid is a no-op), upgrade flag. End-to-end fixture
pipeline: automatic search → comparison → auto-grab → client advance to
completed with full event-chain reconstruction by correlationId; interactive
search + manual pick emitting the decision chain; failed-download handling
(blacklist + automatic re-search picking the next-best release with a
`blacklisted_release` rejection); quality-upgrade ranking including
proper/repack preference; client-level add idempotency. Fixtures only — no
real trackers, usenet providers, or external downloads anywhere.

## Exit evidence

Full checks at time of writing: `pnpm typecheck` clean · `pnpm build` clean ·
`pnpm test` → 18 files / 138 passed / 1 skipped (Postgres CI-gated).
Reviewer acceptance pending (task t_22b5e15b).

### Residual risks / notes
- Series/movies state is in-process per mounted plugin instance; durable
  persistence lands with the library/import work (Phase 4). CI uses fixtures
  only, so this does not affect determinism of the suites.
- MCP search/request/queue/acquisition tools remain unexposed until their
  owning admin surfaces exist (mcp-server.md scope table unchanged).
