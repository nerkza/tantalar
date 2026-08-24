# Wave 10 — Tracker Rules, Naming, and Release Governance

**Card:** `t_50a1f822` · **Scope:** TAN-015, TAN-022, TAN-046, TAN-047
**Date:** 2026-08-24 · **Implementer:** tantalar-dev (Ox Alpha)

## Delivered

### TAN-015 — Real private tracker rules

- `packages/contracts`: `TrackerRule`, `TrackerRuleInput`, `SeedingStats`,
  `ObligationReport`, `TrackerRuleError`, `TRACKER_RULES_CAPABILITY`,
  `validateTrackerRule`, `matchTrackerRule` (announce-host matching, first
  match wins, default rule = enabled rule with no hosts),
  `evaluateObligations` (ratio + seed-time gates with human-readable reasons).
- `plugins/torrent-native`: new `dev.tantalar.capability.torrent.tracker-rules`
  capability (list-rules / put-rule / delete-rule / obligations /
  list-obligations). Rules are stored in the same durable resume document as
  jobs, so they survive plugin restart (test asserts).
- Engine counters extended: `seedingSeconds`, `uploadedBytes`, and per-job
  `tag`. Completed jobs keep advancing to accrue deterministic seeding time.
- **Rules differ by tracker.** Two rules with different announce hosts,
  ratios, seed times, tags, and concurrency limits coexist; matching is by
  announce URL substring.
- **Safe removal.** `remove` with `keepFiles=false` (data deletion) is
  refused (`obligations_unmet`) until every obligation passes. A rule may
  further force file retention via `allowDataRemoval: false` even when
  satisfied. Removal emits `dev.tantalar.event.tracker.removal.decision`
  with rule id/name, obligation status, final keepFiles, and reasons — rule
  decisions are visible in job history.
- **Per-tracker limits.** `maxConcurrent` on a matched rule blocks new adds
  beyond the limit for that tracker only; `tag` lands on the engine torrent.

### TAN-022 — Import and naming settings

- Naming placeholders extended: `codec`, `language`, `edition` added to
  `validateRenameTemplate` (contracts) and the importer renderer. Unknown
  placeholders still fail closed; traversal/absolute templates rejected.
- `plugins/library`: new `preview-rename` (renders a candidate template +
  item into its output path without touching disk; invalid templates throw)
  and `rename-plan` (re-renders every imported item under a candidate
  scheme — review-only, no file moves).
- Server: `apps/server/src/naming-routes.ts` exposes
  `GET/POST /api/v1/naming/schemes`, `POST /api/v1/naming/preview`,
  `GET /api/v1/naming/rename-plan`, `GET /api/v1/naming/recovery-guidance`.
  Guard chain identical to library routes: reads for any signed-in user,
  mutations admin-only with CSRF. Template errors map to 400.
- Web: Settings → Import gained a naming-scheme editor with live episode /
  movie path previews, save fail-closed feedback, a per-scheme bulk rename
  review (changed/total counts, no moves), recovery guidance, and the
  imported catalog. Registration is conditional on the importer capability
  being available.

### TAN-046/047 — Governance

- `docs/traceability.md`: scope-defect flag resolved; post-audit table maps
  TAN-001..047 onto production route, durable data path, UI path, and
  automated acceptance evidence. Fixture-only evidence is explicitly labeled
  prototype evidence.
- `PRD.md`: the four contradictory "In Scope" bullets moved to
  "Out of Scope (v1)" with one consistent statement each (disc images,
  polished HW-accel tuning UI, federation, request portal). In Scope now
  states the settled boundary: embedded download engines are core; external
  daemons are optional integration plugins only; basic HW-acceleration
  detection (VAAPI/NVDEC) is in scope. Architecture section updated to match.

## Checks run

- `pnpm run typecheck` — green.
- `pnpm run build` — green.
- `tests/wave10-tracker-naming.test.ts` — 11/11 pass (rules CRUD/durability,
  invalid rules, safe removal + history event, per-tracker limits/tags,
  restart survival, naming preview/validation/plan, HTTP auth/CSRF/400s,
  recovery guidance).
- Full unit suite, Playwright, packaged-runtime, link/license checks: see
  the card handoff (this doc is updated after the final run).

## Not done (out of scope by card)

- No push, deploy, publish, release, production write, or external message.
- The qBittorrent/SABnzbd adapter plugins remain optional integrations;
  they were not removed (PRD now states this boundary explicitly).
