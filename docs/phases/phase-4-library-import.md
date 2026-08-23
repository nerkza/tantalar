# Phase 4 — Library & Import: Exit Evidence

Status: implemented, pending reviewer acceptance.

## Delivered

- `plugins/library` (`dev.tantalar.plugin.library`, capability `dev.tantalar.capability.importer`):
  - Configurable rename schemes with validated templates (`{series}`, `{season}`, `{episode}`, `{title}`,
    `{year}`, `{quality}`, `{seasonPad2}`, `{episodePad2}`); traversal and unknown placeholders rejected.
  - Hardlink-first import; cross-device/unsupported fallback to copy. Atomic placement via same-directory
    temp file + rename, with a size check before the swap (partial-copy guard).
  - Quality-upgrade replacement: new bytes staged and hash-verified BEFORE the old copy is removed
    (the only good copy is never deleted before replacement verification); per-item history preserved;
    downgrades refused unless forced.
  - Collision handling: identical destination content is an idempotent no-op; different content goes
    through the upgrade gate. Imports idempotent on `(itemKey + sha256(source))`.
  - Security: sources must sit inside configured roots (`importRoots` / `sourceRoots`), symlinks
    rejected, destinations verified inside the library root after realpath resolution.
  - Calendar entries derived from registered monitored media; upcoming-only by default.
  - Events: `*.import.started/completed/failed`, `*.upgrade.replaced`, all correlation-id carrying.
- `plugins/metadata-tmdb-tvdb` (`dev.tantalar.capability.metadata-provider`): fixture TMDB (movies) and
  TVDB (series) adapters returning neutral `MediaMetadata`; emits `*.metadata.refreshed`.
- `packages/contracts`: Phase 4 schemas — `ImportRequest`, `ImportResult`, `RenameScheme`,
  `validateRenameTemplate`, `MediaMetadata`, `MetadataQuery`, `ImportError`, new capability/event names.

## Verification

- `pnpm run typecheck`: clean.
- `pnpm build`: clean (both new plugins added to project references).
- `pnpm test`: 19 files / 150 passed / 1 skipped (Postgres CI-gated), including
  `tests/phase4-library.test.ts` covering: template rendering + traversal rejection, hardlink import,
  idempotency, out-of-root/symlink rejection, upgrade replace-with-history + downgrade refusal,
  interrupted-upgrade rollback (old copy intact, no staging leftovers, ImportFailed traced),
  corrupt/truncated staged-copy guards (hash + size checks) leaving the destination untouched,
  permission-failure cleanup, metadata lookups + misses + event tracing, calendar derivation.
- Fault injection for the guard tests is a test-only seam (`inject-fault` operation /
  `TANTALAR_FAULT` env inside plugins/library) that fires once and is inert in production runs.

## Traceability

Stories 9, 10, 11, 12, 14 updated in [traceability.md](../traceability.md) with named components and tests.

## Non-goals kept

Serving/browsing (Phase 5), download decisions (Phase 3), disc formats. No MCP surface shipped here yet:
the phase doc assigns library read tools to this phase's MCP surface, but the MCP plugin currently exposes
only generic Phase 2 tools; adding library tools is a small follow-up once Phase 5 shapes the read model.

No push or deploy performed.
