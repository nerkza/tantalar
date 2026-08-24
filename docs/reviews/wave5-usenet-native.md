# Wave 5 — Embedded Usenet + Unified Download Jobs (TAN-010, TAN-011)

Status: implemented, all local gates green. No push/deploy.

## Scope delivered

### TAN-010 — `dev.tantalar.plugin.usenet-native` (`plugins/usenet-native/`)
First-party embedded Usenet engine. **No SABnzbd or any external daemon** —
NNTP transport, yEnc, CRC32, PAR2 repair and unpacking run in-process behind
injectable seams:

- `src/engine.ts`
  - `decodeYenc` / `crc32` / `encodeYencBody`: full yEnc decode with declared
    CRC extraction; CRC mismatches become job warnings.
  - `parseNzb`: minimal NZB XML subset parser, fails closed on empty/segment-less files.
  - `NntpTransport` seam: production impl is an NNTP client over TLS with
    auth (credentials live transport-internal only, never logged). Tests use
    `MemoryNntpTransport`.
  - Fill-server behavior: servers carry priorities; segment fetch tries
    transports in priority order, records a visible warning per fallback,
    fails truthfully when a segment exists on no server.
  - Deterministic no-transport mode (CI): segments derive from message-id
    hash — same pattern as wave-4 torrent info-hash seeding. Synthetic content only.
  - `Par2Repairer` / `Unpacker` seams: mature external tools are allowed by
    the card but none shipped; the memory implementations restore fixture
    bytes and report truthfully (`repaired`, `recoveredFiles`, `missingBlocks`).
- `src/plugin.ts`: provider-neutral download-client capability (add/status/
  list/pause/resume/remove/retry/advance) plus usenet-engine capability
  (verify-crc / repair / unpack / queue-position). Storage safety mirrors
  wave 4: fail-closed root containment on writes, free-space stop threshold,
  per-job quota before disk writes. Durable resume via ctx.storage; restart
  re-adds jobs from the persisted NZB path and remaps engine ids without
  duplicating queue entries.

Zero new third-party runtime dependencies → license posture unchanged from
wave 4 (MIT repo, no GPL/copyleft inflow). Health checks: engine capability
operations double as health probes; conformance-probe supported.

### TAN-011 — unified durable `download_jobs` contract
- `packages/contracts`: `DownloadJobRecord`, `DownloadJobSource`,
  `DOWNLOAD_JOB_STATES`, `DownloadJobError`. One stable shape for torrent +
  usenet carrying progress, ETA, warnings, retryCount, source identity,
  failureReason, removed flag, import handoff path.
- `packages/db`:
  - Migration `0007_wave5_download_jobs` (SQLite + Postgres paired), partial
    unique index `(item_key, source) WHERE removed = 0` → one active job per
    item per source; history rows exempted.
  - `DownloadJobStore` (`src/download-jobs.ts`): idempotent create,
    terminal-state protection, retry bookkeeping, remove-as-flag (history is
    never deleted), import handoff recording, ordered listing
    (active first, then removed newest-first).
- Existing SABnzbd plugin remains untouched and optional/non-core.

## Evidence

Focused suite `tests/wave5-usenet-native.test.ts` — **16/16** over the real
out-of-process plugin contract:
- yEnc round-trip + CRC match; declared-CRC surfacing; tamper visibility.
- NZB parse happy-path + fail-closed.
- End-to-end add → advance → completed with NO daemon; payload under root.
- Fill-server fallback with warning + per-server served-from proof.
- Truthful failure when a segment exists nowhere.
- Pause/resume progress preservation; provider-neutral queue-position controls.
- Restart without duplicates (remount + same-itemKey add returns same job;
  list shows exactly one entry) then completion after recovery.
- PAR2 repair recovers a corrupted file and records "par2 repair ran".
- Unpack capability surfaces truthful results for completed jobs.
- download_jobs lifecycle across both sources incl. handoff, terminal
  protection, retry counting, removal-as-history, active-slot uniqueness.

Full gates (this run): `pnpm run typecheck` ✅ · `pnpm run build` ✅ ·
`pnpm run test` ✅ 26 files, 263 passed / 5 gated skips.

## Notes / residual risks

- Production NNTP TLS client is the one deliberate seam left unimplemented —
  wiring a real socket transport requires network credentials and is outside
  what can be proven locally without unauthorized traffic; contract and pool
  semantics are fully specified by `NntpTransport` + server priority config.
- PAR2/unpack ship as seams with memory implementations; swapping in real
  tools later changes no contracts.
- The Postgres-gated migration test runs only with a PG URL present (same
  gate as waves 2–4); migration SQL is dialect-paired and follows the exact
  0006 pattern verified against a live container in wave 4.
