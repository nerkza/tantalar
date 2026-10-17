# Releasing Tantalar

Current release: **0.0.1 Alpha** (`0.0.1-alpha.0`).

Status: **pre-release**. Alpha releases can change configuration and data
formats between versions. Back up before every upgrade (see [deploy.md](deploy.md)).

## Versions

The root `package.json` is the release source of truth. It contains the SemVer
value, human label, and release channel. Derived app manifests, image defaults,
and documentation markers must pass `pnpm run version:check`.
Plugin manifest versions remain independent because plugins have separate
compatibility and release lifecycles.

```sh
pnpm version:set -- <semver> "<human label>" <channel>
pnpm run version:check
```

A version with a prerelease suffix (for example `0.0.2-alpha.0`) is published
as a GitHub prerelease.

## Tags

Each release is one commit on `main` with an annotated tag `v<semver>`,
including the prerelease suffix. Tags are immutable.

## What a release publishes

When a `v*` tag reaches this repository, the release workflow:

1. Runs the full CI suite on the tagged commit.
2. Builds the Docker image from the tagged source and smoke-boots it on SQLite.
3. Pushes `ghcr.io/nerkza/tantalar:<version>` (and `:latest` for stable versions).
4. Generates the SBOM and dependency-license report.
5. Creates the GitHub release with the SBOM attached.

The image tag and the Git tag always name the same version. Each image carries
`org.opencontainers.image.revision` with the tagged commit.

## Rollback

Redeploy the previous immutable tag and restore the pre-upgrade backup
([deploy.md](deploy.md)). Migrations are forward-only by design.
