# Releasing Tantalar v1

Status: **pre-release**. Nothing below has been executed against a public
registry; publishing is approval-gated (Lewis).

## Release checklist

1. All CI jobs green on the release commit (see .github/workflows/ci.yml).
2. Acceptance evidence current: docs/reviews/v1-acceptance-evidence.md.
3. Version bumped in package.json files; changelog entry written.
4. Image built and tagged locally:
   `docker build -t tantalar:v<version> .`
5. Smoke boot from the built image on SQLite and PostgreSQL.
6. SBOM + dependency-license reports regenerated
   (`scripts/generate-sbom.sh`) and attached to the release.
7. Upgrade/rollback rehearsal executed per docs/deploy.md.
8. Approval obtained. Only then: push tag, publish image, GitHub release.

## Tagging

Tags are immutable. `vX.Y.Z` for releases; ` vX.Y.Z-rc.N` for candidates.

## Rollback

Redeploy the previous immutable tag and restore the pre-upgrade backup
(docs/deploy.md). Migrations are forward-only by design.
