# Releasing Tantalar

Current release: **0.0.1 Alpha** (`0.0.1-alpha.0`).

Status: **pre-release**. On 7 September 2026, Lewis confirmed that the public release process remains undecided.
The checklist below is a draft procedure, not an approved release policy.
Release tags, stable/beta channels, version policy, and self-hoster updates still need a decision.
Staging publishes commit-specific development images to GHCR; it does not publish a public release or promote to production.
See [staging deployment](staging.md). Public release publication requires Lewis's approval.

The root `package.json` is the release source of truth. It contains the SemVer
value, human label, and release channel. Derived app manifests, image defaults,
and documentation markers must pass `pnpm run version:check`.
Plugin manifest versions remain independent because plugins have separate
compatibility and release lifecycles.

To prepare the next release:

```sh
pnpm version:set -- <semver> "<human label>" <channel>
pnpm run version:check
```

## Release checklist

1. All CI jobs green on the release commit (see .github/workflows/ci.yml).
2. Acceptance evidence current: docs/reviews/v1-acceptance-evidence.md.
3. `pnpm run version:check` passes; release notes are current.
4. Image built and tagged locally:
   `docker build --build-arg TANTALAR_BUILD_VERSION="$(node scripts/version.mjs show version)" -t "tantalar:$(node scripts/version.mjs show version)" .`
5. Smoke boot from the built image on SQLite and PostgreSQL.
6. SBOM + dependency-license reports regenerated
   (`scripts/generate-sbom.sh`) and attached to the release.
7. Upgrade/rollback rehearsal executed per docs/deploy.md.
8. Approval obtained. Only then: push tag, publish image, GitHub release.

## Tagging

Tags are immutable. Use `v<semver>`, including the prerelease suffix.

## Rollback

Redeploy the previous immutable tag and restore the pre-upgrade backup
(docs/deploy.md). Migrations are forward-only by design.
