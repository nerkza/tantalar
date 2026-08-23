# Launch Workstreams (parallel, low priority)

Runs alongside Phase 6; gates final acceptance, not earlier phases except story 28's CI groundwork (from Phase 1 dual-dialect migrations).

## Scope
1. **Packaging & deploy (story 28)**: single Docker image (Node LTS + ffmpeg), SQLite default volume layout, Postgres via `DATABASE_URL`; one-command run; bare-metal doc secondary. CI publishes the image only after Lewis approves any push/release.
2. **Legal & community**: MIT LICENSE file, CONTRIBUTING.md, SECURITY.md, dependency-license report gate (ADR-016) verified against distributed artifacts.
3. **Marketing site + public wiki**: Starlight implementation in `marketing-site/`; explicitly out of scope for v1 product code, tracked here as a separate workstream.

## Non-goals
Any product behaviour changes; new runtime features.

## Acceptance criteria
- Fresh container boots from the built image; migrations apply on SQLite; boot with Postgres URL applies the same migration set.
- License report generated in CI and clean of GPL in core artifacts.
- LICENSE/CONTRIBUTING/SECURITY present and accurate.

## Test plan
CI image build + smoke boot job; license-report job; doc-link lint.

## Rollback / migration notes
Image tags immutable; rollback = redeploy previous tag. Database migrations forward-only; document downgrade as restore-from-backup (conservative).

## Exit evidence
Published-by-CI image artifact (not pushed externally without approval), green smoke job, license report artifact, docs, reviewer acceptance feeding final acceptance card.
