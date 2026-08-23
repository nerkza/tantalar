# Deploying Tantalar v1

One command, one image. SQLite is the default database; PostgreSQL is a
configuration choice, not a different image.

## Quick start (SQLite)

```sh
docker build -t tantalar:v1 .
docker run -d --name tantalar -p 8787:8787 -v tantalar-data:/data tantalar:v1
curl -fsS http://127.0.0.1:8787/healthz   # {"ok":true}
```

Or with compose:

```sh
docker compose -f docker/compose.sqlite.yml up -d
```

Data (SQLite file + backups) lives in the `tantalar-data` volume at `/data`.

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
| `TANTALAR_PORT` | `8787` | Listen port inside the container |
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
docker run -d --name tantalar -p 8787:8787 -v tantalar-data:/data tantalar:vN+1
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
node apps/server/dist/main.js            # listens on 127.0.0.1:8787
```

Put TLS termination in a reverse proxy; cookies ship `secure:false` by
design because TLS ends at the proxy (architecture §5).
