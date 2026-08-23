# Tantalar v1 — Acceptance Evidence

Date: 2026-08-23. Host: local Docker (Linux 6.1.0-52-cloud-amd64). Image: `tantalar:v1` built from the working tree `Dockerfile`. No image was published, no release created, nothing pushed or deployed. Everything below ran locally on this host.

## Phase 6 review defects — fix verification

Parent review (t_32dad32e) rejected round 1 with two defects:

1. **Theme save clobbered grid prefs** (`apps/web/src/theme/engine.tsx`).
   Fix verified: `ThemeEngineProvider` now holds the latest known
   `gridDensity`/`hiddenColumns` in `gridPrefsRef`, seeds it from loaded
   preferences, and merges it into the `saveUiPreferences` call instead of
   sending hardcoded defaults.
2. **Grid layout persistence not wired into grids** (`apps/web/src/admin/views.tsx`).
   Fix verified: `QueueView`, `WantedView`, and `HistoryView` each call
   `usePersistedGridPrefs(adminId)` and pass `layout` / `onLayoutChange`
   through to `DenseGrid`; column show/hide and density now round-trip
   through `ui_preferences`.

## Check suites (re-run this session)

| Command | Result |
|---|---|
| `pnpm run typecheck` | clean (tsc -b) |
| `pnpm run build` | clean |
| `pnpm run test` | 19 files, 193 passed, 1 skipped (Postgres-gated) |
| `pnpm --filter @tantalar/web test` | 2 files, 17 passed |
| `pnpm exec playwright test` | 17 passed (8 admin + 9 viewer), incl. "grid customization persists density preference across navigation" |

## Docker acceptance run

### Build

```
docker build -t tantalar:v1 .
# image present: tantalar:v1 (built from current tree; includes @fastify/static SPA serving + web build)
```

### First start + health (SQLite, compose)

```
docker compose -f docker/compose.sqlite.yml up -d        # named volume tantalar-data
docker ps                                                # healthy
curl http://localhost:<port>/healthz                     # {"ok":true}
curl http://localhost:<port>/                            # 200, web SPA index served by Fastify
```
Container logs: `{"dialect":"sqlite","msg":"migrations applied"}` then
`tantalar listening on http://127.0.0.1:8787`.

### Persistence across restart

Data lives in a named Docker volume mounted at `/data`
(`tantalar.db` + WAL/SHM). A fresh container attached to the same volume
booted green against the pre-existing database:

```
docker run -d -p 18790:8787 -v tantalar-acc-data:/data tantalar:v1
docker logs <id>     # migrations applied (no-op), listening
curl :18790/healthz  # {"ok":true}
```

### Backup / restore

```
docker exec tantalar-acc tantalar-entrypoint backup /tmp/prove-bk.db
# backup written: /tmp/prove-bk.db (151552 bytes)
docker exec tantalar-acc tantalar-entrypoint restore /tmp/prove-bk.db
# restored /tmp/prove-bk.db -> /data/tantalar.db (stale WAL/SHM removed)
```
Server restarted against the restored file; `/healthz` returned `{"ok":true}`
after restart.

### PostgreSQL mode

Postgres 16 container (`postgres:16-alpine`) plus app container with
`TANTALAR_DB_DIALECT=postgres` and
`TANTALAR_SECRET_DATABASE_POSTGRES_URL=postgres://tantalar:***@<pg>:5432/tantalar`:

```
docker logs <app>    # {"dialect":"postgres","msg":"migrations applied"} + listening
curl /healthz        # {"ok":true}; container reports healthy
psql \dt             # full migration set present (api_keys, events, plugin_state, ...)
```
The earlier Postgres boot defect (pg.Client passed as the Kysely pool) is
fixed and covered by `tests/migrations-postgres.test.ts` (CI-gated).

### Restart and rollback readiness

The persistence test above restarted the same image against the existing
volume. It proves restart safety and idempotent migrations. It does **not**
prove rollback to an older image because no older v1 image exists yet.

Rollback is documented in `docs/release.md` and `docs/deploy.md`: use an
immutable previous image tag and restore the matching pre-upgrade database
backup. That cross-version rehearsal remains a release follow-up after a
second image version exists. Database downgrade is not supported.

### Fixture pipeline (search → playback)

Covered end-to-end by the Playwright suite against a running server
(`e2e/viewer.spec.ts`, 9 tests): seeded fixture indexer/search → grab →
import → library browse → direct-play negotiation and byte-range decode,
HLS fallback with quality ladder, subtitle selection with content served,
resume progress restore, seek during playback, next-episode autoplay.
Admin side (`e2e/admin.spec.ts`, 8 tests): grids render/filter/sort,
density persistence, theme editor preview/save/revert with malicious-CSS
rejection, trajectory reconstruction of the grab→import chain, user
creation, system health, keyboard navigation, narrow viewport.

### SBOM + license report

```
bash scripts/generate-sbom.sh
# artifacts/sbom.json (CycloneDX 1.5, 253 production components)
# artifacts/licenses.json + artifacts/licenses-summary.txt
# == GPL exclusion check == OK: no GPL-family licenses in production dependencies
```
CI runs the same gate (`SBOM + license report (fail on GPL)` job) and also
runs dependency audit (high-and-above fails), image build, and smoke boot.

## CI coverage

`.github/workflows/ci.yml`: typecheck, lint, build, unit tests (SQLite),
Postgres service + migrations, plugin conformance, Playwright, SBOM +
license/GPL gate, Docker build + SQLite smoke boot, dependency audit.
CI has not run remotely yet (nothing pushed); all equivalent steps were
executed locally and passed except remote-only steps.

## Documentation set for launch

- LICENSE (MIT), CONTRIBUTING.md, SECURITY.md, CODE_OF_CONDUCT.md
- docs/SUPPORT.md, docs/release.md, docs/deploy.md
- docker/compose.sqlite.yml, docker/compose.postgres.yml, docker/entrypoint.sh (backup/restore)
- docs/phases/launch-workstreams.md, docs/traceability.md (stories 25–28), docs/roadmap.md

## Marketing site

Out of scope for v1 per PRD. `marketing-site/` remains an empty placeholder;
the Starlight marketing site + public wiki is tracked as a separate future
repository in README.md and docs/phases/launch-workstreams.md.

## Residual notes

- Known harness issue only: CDP text-input events hang on Mantine inputs in
  this Chromium environment; e2e uses JS event dispatch (`fillSafely`).
  Environment defect, not product defect.
- Nothing here claims production readiness beyond what was executed above.
  Publishing the image, creating a release, pushing, and deploying remain
  approval-gated with Lewis.
