# Wave 4 — Embedded torrent engine (TAN-009, TAN-012)

## What shipped

`plugins/torrent-native` (`dev.tantalar.plugin.torrent-native`) — an embedded
torrent engine plugin. No qBittorrent or external daemon is required. It
speaks the existing provider-neutral `dev.tantalar.capability.download-client`
contract plus a new `dev.tantalar.capability.torrent.engine` capability.

### Architecture

- `src/engine.ts` — the protocol seam: bencode decode, `.torrent` parsing
  (info-hash over the raw `info` slice), magnet parsing, piece coverage
  mapping, and the `TorrentEngine` interface with a deterministic offline
  `MemoryTorrentEngine` transport.
- `src/synthetic.ts` — legal synthetic fixture generator (bencode encoder +
  multi-file torrent builder). All test content is generated in-repo; announce
  URLs point at `.invalid` hosts and are never contacted.
- `src/plugin.ts` — Tantalar-owned policy:
  - durable job + resume state through the core storage bridge
    (`ctx.storage`, `plugin_documents`, survives restart/crash);
  - queue order, pause/resume/retry, idempotent adds;
  - storage safety (TAN-012): fail-closed root containment on every write,
    free-space stop thresholds via `statfsSync`, per-job quotas, explicit
    contained cleanup with audit events;
  - file selection and per-job controls on the engine capability.

### License review (ADR-0016)

The current engine transport is the in-repo `MemoryTorrentEngine` — zero new
runtime dependencies, so no license exposure ships in this wave. The design
keeps a clean seam for a real wire protocol later; if webtorrent (MIT) is
adopted then, its tree is MIT/BSD/Apache/ISC-class except `node-datachannel`
(MPL 2.0, web-RTC only), `sax` (BlueOak, parser fallback), and `expand-template`
(MIT OR WTFPL) — all non-GPL but each needs an entry in ADR-0016's report
before any adoption. Recorded here so the decision is documented.

### Tests

`tests/wave4-torrent-native.test.ts` — 19 tests over the real out-of-process
plugin contract, proving:

1. add → advance → completed end-to-end without any daemon;
2. piece verification by hashing, corruption detection and repair marking;
3. pause/resume preserving progress, retry clearing failure state;
4. queue-position reordering, file selection, idempotent adds;
5. durable resume across unmount/remount (restart recovery);
6. free-space stop thresholds under simulated low disk;
7. per-job quota enforcement before disk writes;
8. write containment (nothing lands outside configured roots);
9. explicit, contained, auditable cleanup;
10. fail-closed rejection of NZB releases and unsafe source URLs.

Also fixed: `tests/migrations-postgres.test.ts` gated its Postgres case on
`db` (assigned in `beforeAll`) inside `it.skipIf`, which evaluates at suite
definition time — so the migration check silently skipped even in CI where
`TANTALAR_CI_POSTGRES=1`. Now gates on `pgUrl` like wave2's concurrency suite.
Verified green against a live Postgres 16 container.

## Gate results

- `pnpm run typecheck` — green
- `pnpm run build` — green
- `pnpm run test` — 25 files / 247 passed / 5 skipped
  (skips = Postgres-gated suites without `TEST_POSTGRES_URL`; both pass with
  a live Postgres 16, verified locally)
- wave4 suite — 19/19, stable across repeated runs

## Residual notes for review

- Magnet-only jobs report size 0 until metadata arrives; quota checks treat
  them conservatively (pass-through) until real engines supply sizes.
- The memory engine seeds payloads deterministically from the info-hash; it
  is a test transport, not a wire implementation, and is documented as such.
- qBittorrent adapter remains optional/non-core per card scope; default config
  still mounts the fixture client (unchanged this wave).
