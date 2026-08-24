# Tantalar v1

One self-hosted web app to replace the Plex + \*arr + downloader stack. Library serving, wanted-list automation, indexer search, NZB/torrent acquisition, and post-processing — built "everything is a module/plugin" from the ground up.

- **PRD**: [PRD.md](./PRD.md)
- **Status**: v1 accepted locally on 2026-08-23. All six phases passed independent review. See [v1 acceptance evidence](./docs/reviews/v1-acceptance-evidence.md).
- **Architecture**: [docs/architecture.md](./docs/architecture.md) — components, topology, trust boundaries, failure modes
- **Traceability**: [docs/traceability.md](./docs/traceability.md) — PRD stories 1–32 mapped to phases and tests
- **Roadmap**: [docs/roadmap.md](./docs/roadmap.md) — 6 phases, core kernel first
- **Phase plans**: [docs/phases/](./docs/phases/) — phase-0 … phase-6 plus launch workstreams
- **ADRs**: [docs/adrs/](./docs/adrs/) — 18 locked decisions (ADR-0001 … ADR-0018)
- **MCP server**: [docs/mcp-server.md](./docs/mcp-server.md) — contract for the `dev.tantalar.plugin.mcp` server
- **Plugin guide**: [docs/guides/first-plugin.md](./docs/guides/first-plugin.md) — your first Tantalar plugin in under 30 minutes
- **License**: [MIT](./LICENSE)

## Quick start

```bash
pnpm install
pnpm run typecheck
pnpm test            # unit and integration suites; Postgres migration job in CI
pnpm --filter @tantalar/server build
node apps/server/dist/main.js --dump-config   # redacted effective config
node apps/server/dist/main.js                 # boots on 127.0.0.1:8790
```

## Layout

| Path | Purpose |
|---|---|
| `apps/server` | Core kernel: boot sequence, HTTP/WS, supervisor, event bus, scheduler, auth |
| `apps/web` | React/Mantine admin, library and player application |
| `packages/contracts` | Event envelope, manifest, capability names, UUIDv7 (locked ADR shapes) |
| `packages/config` | Layered YAML config, env secrets, redacted `--dump-config` |
| `packages/db` | Kysely dual-dialect (SQLite WAL / PostgreSQL) migrations + schema |
| `packages/plugin-sdk` | Public SDK for plugin authors |
| `packages/testkit` | Conformance fixtures (Phase 2) |
| `plugins/*` | First-party and fixture plugins using the same public contract |
| `tests/` | Vitest unit, integration, plugin, acquisition, library and serving suites |
| `e2e/` | Playwright viewer and admin acceptance flows |
| `docker/` | SQLite/PostgreSQL compose files and backup/restore entrypoint |
| `marketing-site/` | Own repo — Starlight marketing site + public wiki (launch-phase) |

## Core guarantees verified by v1 tests

- Boot order: config → DB migrate → event log → container → supervisor → HTTP.
- Events are append-only; append precedes fan-out; replay by time/type/subject/correlation/cursor.
- Plugins run out-of-process; `kill -9` never takes the server down; restart policy with backoff and a failure window.
- Capability resolution fails hard on missing/ambiguous providers; registration is reversible.
- Argon2id passwords, opaque sessions (HttpOnly SameSite=Lax cookies), CSRF double-submit, SHA-256-hashed scoped API keys.
- `--dump-config` never prints secrets.
