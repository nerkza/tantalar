# Deploying Tantalar

Current release: **0.0.1 Alpha** (`0.0.1-alpha.0`).

For the marketing site, application, and metadata staging environments, see [Staging deployment](staging.md).

One command, one image. SQLite is the default database; PostgreSQL is a
configuration choice, not a different image.

## Quick start (SQLite)

```sh
export TANTALAR_IMAGE_TAG="$(node scripts/version.mjs show version)"
export TANTALAR_BUILD_REVISION="$(git rev-parse HEAD)"
export TANTALAR_BUILD_DATE="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
docker build \
  --build-arg TANTALAR_BUILD_VERSION="$TANTALAR_IMAGE_TAG" \
  --build-arg TANTALAR_BUILD_REVISION="$TANTALAR_BUILD_REVISION" \
  --build-arg TANTALAR_BUILD_DATE="$TANTALAR_BUILD_DATE" \
  -t "tantalar:$TANTALAR_IMAGE_TAG" .
docker run -d --name tantalar -p 8790:8790 -v tantalar-data:/data "tantalar:$TANTALAR_IMAGE_TAG"
curl -fsS http://127.0.0.1:8790/api/v1/version
```

Or with compose:

```sh
export TANTALAR_IMAGE_TAG="$(node scripts/version.mjs show version)"
docker compose -f docker/compose.sqlite.yml up -d
```

Data (SQLite file + backups) lives in the `tantalar-data` volume at `/data`.

## Usenet repair and archive extraction

The native downloader uses `par2` for recovery and `7zz` (or `7z`) for archive extraction. These are short-lived local processes. No download daemon is required.

On macOS:

```sh
brew install sevenzip par2
```

Restart Tantalar after installation. Acquisition shows repair and extraction availability separately from news-server configuration.

Use a current 7-Zip build with RAR support. Some distribution packages omit the RAR codec. The local acceptance run used 7-Zip 26.03 and par2cmdline 1.3.0. Official releases: [7-Zip](https://www.7-zip.org/download.html) and [par2cmdline](https://github.com/Parchive/par2cmdline).

The standard image does not bundle these tools under [ADR-0016](adrs/0016-no-gpl-in-core-artifacts.md). Container operators must supply Linux executables and required shared libraries on the container's `PATH`. A macOS executable cannot run inside the Linux image. CI installs these dependencies outside the distributed image and verifies archive extraction with a real RAR5 fixture.

Repair needs enough valid PAR2 recovery blocks. Password-protected archives are rejected. Extraction rejects unsafe filenames, links, and output that exceeds storage limits. Allow free space for the download, repair copies, and extracted media.

The importer derives allowed destinations from enabled libraries and allowed sources from the selected native downloader. Each managed title still needs an enabled destination library.

## PostgreSQL mode

```sh
POSTGRES_PASSWORD=choose-a-strong-password \
  docker compose -f docker/compose.postgres.yml up -d
```

The URL reaches the server only through
`TANTALAR_SECRET_DATABASE_POSTGRES_URL` — the config system treats it as a
secret and redacts it in `--dump-config` output.

## Configuration

The entrypoint writes a host config layer from these variables:

| Variable | Default | Purpose |
|---|---|---|
| `TANTALAR_PORT` | `8790` | Listen port inside the container |
| `TANTALAR_DB_DIALECT` | `sqlite` | `sqlite` or `postgres` |
| `TANTALAR_DATA_DIR` | `/data` | SQLite path + backup root |
| `TANTALAR_SECRET_DATABASE_POSTGRES_URL` | — | Postgres URL (postgres mode) |

Inspect the effective config (secrets redacted):

```sh
docker exec tantalar node apps/server/dist/main.js --dump-config
```

## Health checks

- `/healthz` — liveness; used by the image HEALTHCHECK.
- `/readyz` — readiness; 503 until boot completes.
- `/api/v1/system/health` — admin surface: readiness + event-log count +
  per-plugin state (degraded reporting when a subsystem fails to report).

## Backup and restore

Backups are consistent SQLite snapshots taken through the engine's online
backup API, so they are safe while the server runs.

Backup:

```sh
docker exec tantalar tantalar-entrypoint backup
# -> /data/backups/tantalar-<timestamp>.db (in the tantalar-data volume)
docker cp tantalar:/data/backups/<file>.db ./tantalar-backup.db
```

Restore (stop the server first so the file is not being written):

```sh
docker stop tantalar
docker cp ./tantalar-backup.db tantalar:/tmp/restore.db
docker start tantalar
docker exec tantalar tantalar-entrypoint restore /tmp/restore.db
docker restart tantalar
```

PostgreSQL mode: use standard Postgres tooling instead
(`pg_dump` / `pg_restore`). Tantalar migrations are forward-only; downgrade
is restore-from-backup of both the image tag and the database dump.

## Upgrade / rollback rehearsal

Upgrades are image-tag swaps on the same data volume:

```sh
docker build -t tantalar:vN+1 .          # new version
docker stop tantalar && docker rm tantalar
docker run -d --name tantalar -p 8790:8790 -v tantalar-data:/data tantalar:vN+1
```

Migrations apply automatically at first start. Rollback = redeploy the
previous tag after restoring the pre-upgrade backup (migrations do not run
backwards). Rehearse this before every production upgrade. See
docs/reviews/v1-acceptance-evidence.md for current restart evidence and the
remaining cross-version rollback limitation.

## Bare metal (secondary)

Node >= 22, pnpm 11, ffmpeg on PATH:

```sh
pnpm install && pnpm run build
node apps/server/dist/main.js            # listens on 127.0.0.1:8790
```

Put TLS termination in a reverse proxy; cookies ship `secure:false` by
design because TLS ends at the proxy (architecture §5).
