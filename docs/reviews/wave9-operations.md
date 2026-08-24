# Wave 9 — Operations, Accessibility, Recovery, and Scale

**Card:** `t_bdf91ff8` · **Scope:** TAN-030–038, TAN-042, TAN-043
**Date:** 2026-08-24 · **Implementer:** tantalar-dev (Ox Alpha)

## Delivered

### TAN-030 — Complete queue and history UX
- New core-owned `/api/v1/queue` routes over the durable `download_jobs`
  store (`apps/server/src/ops-routes.ts`). Every action targets each job's
  stored `providerPluginId` (engine identity) — no fixture provider ids.
- Actions: pause / resume / retry / prioritize / remove with state-machine
  guards (409 on invalid transitions), integer priority validation.
- Removal is flag-only (durable history retained) and states its data-file
  consequence; destructive intent confirmed in the UI before dispatch.
- Failure details and import-handoff status are first-class columns.
- `priority` column added to `download_jobs` (migration 0009).

### TAN-031 — Complete plugin management
- Plugins view gained Restart and Disable controls with truthful states.
- Disable explains service impact before the action (`requiredBy` from the
  supervisor manifests via `/api/v1/plugins/:id/detail`).
- `Supervisor.restart()` added: unmount + remount with original config,
  awaiting mount completion so responses report post-restart truth.

### TAN-032 — User + library permissions with audit log
- New user management: role change, password reset (Argon2id), session
  revoke, deactivate/reactivate. Deactivation revokes live sessions and
  fails sign-in (`AuthService.verifyPassword`, `getSession`).
- Last-admin safeguard enforced server-side: demoting or deactivating the
  final active administrator returns 409; users cannot deactivate self.
- Library access grants per user (`PUT/GET /api/v1/users/:id/libraries`),
  validated against existing libraries (fail-closed).
- Immutable `audit_log` table (migration 0009); every security-sensitive
  mutation writes an entry. Surfaced via the new admin Audit tab.

### TAN-033 — API keys, webhooks, MCP settings
- API keys: scoped creation with optional ISO expiry; expired keys fail
  closed at verification. Plaintext secret returned exactly once, never
  persisted or echoed by list endpoints. Revocation durable.
- Webhooks: destination CRUD storing only the signing env-var NAME;
  test delivery reports truthful outcomes (delivered / failed /
  skipped_no_secret) without exposing secret material. Delivery history
  columns on `outbound_webhooks` (migration 0009).
- MCP status read-only endpoint: mounted state, version, audited call
  count from the immutable event log, default policy statement.

### TAN-034 — Operational Activity
- Activity view retains type/subject/correlation filters plus chain
  reconstruction; events link to jobs/media via subjects and correlation
  ids already emitted across waves. Live feed recovery unchanged (WS).

### TAN-035 — Mobile navigation and tables
- Compact header (single row at 320px): burger + brand left, compact-sm
  Admin/Sign out right; no wrapped action rows.
- Burger exposes aria-expanded/aria-controls; navbar labelled.
- Verified visually and via Playwright at 320px.

### TAN-036 — Loading / empty / error / offline states
- DenseGrid supports a loading mode rendering fixed-height skeleton rows —
  table geometry never jumps between empty/loading/data.
- App-level offline banner (`navigator.onLine` + events) appears without
  wiping the current view; every data view keeps distinct loading, empty,
  permission, error+retry states.

### TAN-037 — Keyboard and screen-reader support
- Visible skip-link to `#main-content`, focus-visible outlines globally,
  sortable headers keyboard-operable with aria-sort (restored + kept),
  grid tables named via aria-label, tab list semantics preserved.

### TAN-038 — Server-side grids
- `/api/v1/catalog/page`: server-side pagination (page/pageSize capped),
  search filter, sort key/direction, total + totalPages counts.
- Client `api.catalogPage` typed wrapper for product grids.

### TAN-042 — Backup, restore, migration controls
- `POST /api/v1/system/backup`: better-sqlite3 online backup to a temp
  file, integrity_check before rename (atomic), reports included dataset.
- `POST /api/v1/system/restore`: validates integrity + Tantalar schema of
  the backup BEFORE replacement, snapshots the live DB as a safety copy,
  replaces atomically, drops stale WAL/SHM, path-restricted to the managed
  backups directory.

### TAN-043 — Diagnostics + support bundle
- Diagnostics endpoint: versions, module states, event count, transcoder
  support, VPN capability presence.
- Support bundle: preview lists sections before export; export redacts API
  keys, passwords/tokens/secrets, and configured media names unless the
  operator explicitly opts in; config is reduced to shape (keys only).
- Export writes a downloadable JSON bundle from Settings → System.

## Tests

- **Unit (`tests/wave9-operations.test.ts`, 20 tests):** auth guards,
  queue lifecycle incl. engine-targeted actions and removal semantics,
  last-admin refusals, deactivated sign-in failure, one-time key secret,
  expired-key fail-closed, webhook env-var-name-only storage, MCP status,
  catalog pagination, atomic/integrity-checked backup, restore path and
  validation refusals, diagnostics, bundle redaction (media titles and
  key patterns absent).
- **Web vitest (`apps/web/test/wave9-operations.test.tsx`, 9 tests):**
  queue operational detail and state-appropriate actions, removal note
  surfacing, plugin restart/disable controls, per-user management
  controls, verbatim last-admin error surfacing, audit view columns,
  Audit tab present.
- **Playwright (`e2e/wave9-operations.spec.ts`, 5 tests):** skip link
  focus behaviour, audit tab reachable, System section backup/restore/
  diagnostics/bundle visible with truthful notes, API-key creation showing
  the secret exactly once then removing it from the DOM, 320px usability.
- **Regression:** full unit suite 320 passed / 5 gated skips; web vitest
  38/38 (29 pre-existing + 9 new); Playwright 28/28 (23 pre-existing +
  5 new). Typecheck and build clean.

## Evidence

- Screenshots (desktop 1280 + mobile 320):
  - `/srv/projects/artifacts/wave9-admin-queue.png` — durable queue with
    engine identity, priority, failure detail columns, Pause/Remove.
  - `/srv/projects/artifacts/wave9-admin-audit.png` — security audit log
    view (When/Actor/Action/Target).
  - `/srv/projects/artifacts/wave9-settings-integrations.png` — API keys,
    webhooks, MCP status sections.
  - `/srv/projects/artifacts/wave9-settings-system.png` — backup/restore,
    diagnostics, support-bundle blocks with redaction options.
  - `/srv/projects/artifacts/wave9-mobile-320-admin.png` — compact mobile
    layout, single header row, no horizontal overflow.
- Capture script: `scripts/wave9-evidence.ts`.

## Security decisions honoured

- Secrets display once and never reappear (verified by index-of test and
  DOM-removal e2e).
- Last-admin safeguard + mandatory audit log are server-side, not UI-only.
- Restore validates version/schema/integrity before replacement.
- Support bundles redact secrets and configured media names by default.

## Residual risks / non-blocking notes

- Plugin enable-after-disable remains config-driven (returns 409 with an
  explanation rather than silently remounting); full dynamic enablement is
  deferred until the plugin-set config surface gains write APIs.
- Catalog pagination endpoint currently admin-gated; viewer-facing product
  grids can adopt it when viewer paging lands (TAN-015 wave).
- Queue "remove" delegates actual data-file deletion to the owning engine's
  future remove-with-data contract; today it always flags + retains files
  and says so truthfully in the response.
- No push, deploy, release, or production writes performed.
