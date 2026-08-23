# Tantalar — Technical Architecture

Status: Phase 0 · 2026-08-22
Companion docs: [Traceability](traceability.md) · [Phases](phases/) · [ADRs](adrs/) · [MCP server](mcp-server.md)

## 1. Overview

Tantalar is a single self-hosted web application: one Node process tree serving REST + WebSocket APIs, a web UI, an out-of-process plugin runtime, an append-only event log, and a media streaming layer. Core provides only generic machinery. All product behaviour (series/movies automation, indexers, download clients, VPN, importer, library, player) lives in modules that mount through the same public plugin contract used by third-party plugins.

## 2. Monorepo layout (pnpm workspace)

| Package | Purpose |
|---|---|
| `apps/server` | Core kernel: HTTP/WS server, supervisor, event bus, scheduler, auth, streaming |
| `apps/web` | React + Mantine SPA (admin + player) |
| `packages/contracts` | Protobuf IDL, generated types, event schemas, capability names |
| `packages/plugin-sdk` | Public SDK for plugin authors (any language; TS first) |
| `packages/testkit` | Conformance harness, fixtures, in-memory plugin stub |
| `packages/config` | Layered YAML config loading, redaction, `--dump-config` |
| `packages/db` | Kysely schema types, migrations (SQLite + PostgreSQL) |
| `plugins/*` | First-party plugins (series, movies, indexers, downloaders, vpn, importer, library, streaming-ui glue, mcp-server) |

Dependency rule: `plugins/*` and `apps/web` may depend on `packages/*` only. `packages/*` never depends on a plugin. `apps/server` depends on `packages/*` and mounts plugins at runtime — never their source.

## 3. Runtime topology

```
┌─────────────────────────── host ───────────────────────────┐
│  apps/server (Node LTS, single main process)               │
│   ├─ HTTP/WS (Fastify)                                     │
│   ├─ Scheduler                                             │
│   ├─ Event bus + append-only event log                     │
│   ├─ Service container                                     │
│   ├─ Auth (sessions, API keys)                             │
│   ├─ Plugin Supervisor                                     │
│   │    ├─ plugin process A (gRPC server, any language)     │
│   │    ├─ plugin process B …                               │
│   │    ├─ MCP server (dev.tantalar.plugin.mcp)             │
│   │    └─ ffmpeg HLS workers (per transcode session)       │
│   └─ Kysely → SQLite (default) / PostgreSQL                │
│  apps/web (static assets served by Fastify in production)  │
└────────────────────────────────────────────────────────────┘
```

One server process owns all state. Plugin and ffmpeg workers are children; their loss never corrupts core state. v1 does not shard or cluster; the conservative default is a single writer process.

## 4. Component boundaries

- **Kernel** (`apps/server/src/kernel`): boot sequence, config load, DB open + migrate, event log open, service container init, supervisor start, HTTP listen. Owns process lifecycle and graceful shutdown ordering.
- **Event bus**: in-process pub/sub over typed envelopes. Delivery is synchronous-dispatch onto async queues per subscriber; a slow subscriber cannot block the producer. Bus append is the source of truth: every bus publish is appended to the event log first, then fanned out.
- **Service container**: registry of capabilities. Plugins declare `provides`/`requires` capabilities in their manifest using reverse-DNS names (e.g. `dev.tantalar.capability.downloader`). Resolution is strict: missing or ambiguous provider is a hard boot/mount error with rollback.
- **Supervisor**: spawns plugin processes, performs gRPC handshake, health-checks on an interval, applies restart policy (exponential backoff, max-restart window), owns mount/unmount rollback (deregister capabilities, cancel subscriptions), and reports state on the WS feed.
- **Scheduler**: cron-like dispatch. Jobs are declared by plugins via the contract; the scheduler persists job state so restarts do not double-fire (idempotency keys required).
- **Auth**: Argon2id password hashes, opaque server-side session tokens in secure HttpOnly SameSite=Lax cookies, CSRF double-submit token for cookie-authenticated mutations, hashed scoped API keys (`tantalar_…`, stored as SHA-256) for machine access.
- Streaming: direct play streams the file bytes (HTTP range requests) with no ffmpeg involvement. Transcode sessions spawn one bounded ffmpeg HLS worker each; sessions are negotiated, capped (count, CPU, memory, disk), and reaped on idle/exit.
- **MCP server** (`plugins/mcp-server`, `dev.tantalar.plugin.mcp`): out-of-process plugin exposing Tantalar to external AI clients over MCP. Public-contract access only; scoped API keys via the contract's auth-introspection capability; reads on / mutations off by default; immutable audit event per call. Full contract: [docs/mcp-server.md](mcp-server.md), decision: [ADR-0018](adrs/0018-mcp-server-plugin.md).

## 5. Trust boundaries

1. Web browsers ↔ server: cookie or API-key auth over TLS (TLS terminated by reverse proxy in the reference deployment; the server itself serves plain HTTP on loopback/LAN).
2. Server ↔ plugins: gRPC over Unix domain sockets (mode 0600, per-plugin socket dir) or loopback TCP with a per-boot shared secret when sockets are unavailable. Plugins are untrusted: they may only reach capabilities they declared, and never the database or filesystem outside declared roots.
3. Server ↔ ffmpeg workers: argv + stdio only; workers have no capability access.
4. Server ↔ internet (indexers, metadata providers, trackers): outbound via the VPN module when a download-client binding says so; metadata/indexer traffic is direct by default.
5. External AI clients ↔ MCP server (`dev.tantalar.plugin.mcp`): scoped API keys over MCP Streamable HTTP on loopback by default; non-loopback binds require explicit configuration plus TLS at a trusted reverse proxy. The MCP server is an untrusted out-of-process plugin: it reaches Tantalar only through the public contract and its declared capabilities ([ADR-0018](adrs/0018-mcp-server-plugin.md), [MCP contract](mcp-server.md)).

## 6. Plugin lifecycle

States: `registered → starting → healthy → degraded → restarting → stopped → failed → unmounted`.

- Mount = validate manifest → resolve capabilities → spawn → handshake (protocol version check) → register providers/subscriptions → publish `plugin.mounted`. Any failure rolls back all registration in reverse order.
- Unmount = quiesce (stop accepting) → drain in-flight RPCs (bounded) → revoke capabilities/subscriptions → SIGTERM → SIGKILL after grace → publish `plugin.unmounted`.
- Crash = supervisor restarts with backoff; repeated failure within the window marks `failed` and emits an alert event. A crashed plugin cannot corrupt the event log: appends happen in core.
- Config-driven install/disable/swap: the plugin set is declarative in config; applying config diff mounts/unmounts accordingly.

## 7. Event bus and event log

Envelope (protobuf + TS type, canonical in `packages/contracts`):

```
schemaVersion, eventId (UUIDv7), type (reverse-DNS, e.g.
dev.tantalar.event.release.grabbed), occurredAt, producer,
subject, correlationId, causationId, payload, metadata
```

- Append-only. Events are immutable after write. No UPDATE/DELETE path exists in code or DB permissions.
- `correlationId` groups one logical operation (a search→grab→import chain); `causationId` points at the directly-causing event.
- Consumers must be idempotent: redelivery on crash/replay must not double-apply. The log read API supports replay by time, type, subject, and correlationId — this powers the Activity/Trajectory view.
- Retention: v1 keeps events indefinitely (SQLite-sized); a pruning job is config-gated and off by default (conservative default).

## 8. Configuration

Layered YAML: defaults (in `packages/config`) → profile file → host file → CLI flags. Later layers override earlier ones by deep merge; lists replace unless the key ends in `+` (append). Environment variables supply secrets only (`TANTALAR_SECRET_*`). `--dump-config` prints the effective tree with secrets redacted; dumped output is valid as an input layer. Config is validated against a schema at boot; unknown keys warn, never silently pass.

## 9. Persistence

- Kysely as the typed query layer. Dialects: `better-sqlite3` (default, WAL mode) and `pg`.
- Migrations are plain SQL-per-dialect pairs sharing one numbered sequence; CI runs both engines on every migration before any phase exits.
- Core tables: `users`, `sessions`, `api_keys`, `events`, `scheduler_jobs`, `plugin_state`, plus per-plugin domain tables owned by that plugin's module code (plugins still cannot write them directly — their module code in `plugins/*` does, through `packages/db`).
- Data ownership: the event log and auth tables are core-owned; everything else is owned by the built-in module that introduced it. Dropping a plugin never deletes its tables; uninstall offers explicit data-retention choices.

## 10. HTTP / WebSocket APIs

- Fastify. REST under `/api/v1`. OpenAPI document generated at runtime from the same schema objects that validate requests (TypeBox). No hand-written OpenAPI.
- Auth: cookie sessions for the web UI; `Authorization: Bearer tantalar_…` hashed API keys for machines. CSRF token required for cookie-based mutations.
- WebSocket `/api/v1/events`: authenticated event feed with replay-from cursor and filtered subscriptions (type prefix, subject). The web UI and third-party integrations use the same feed.
- Streaming endpoints: `/api/v1/stream/{fileId}` (direct play, HTTP range) and `/api/v1/transcode-session` negotiation returning an HLS manifest URL.

## 11. Failure modes

| Failure | Behaviour |
|---|---|
| Plugin crash | Supervisor restart with backoff; capabilities revoked during downtime; callers see capability-unavailable |
| DB unavailable at boot | Boot fails loudly; no degraded mode (conservative) |
| DB failure at runtime | API returns 503; event bus buffers bounded then sheds load; no in-memory-only state mutation |
| ffmpeg worker hang | Session watchdog kills worker, frees slot, emits event |
| Tunnel down with kill switch | Download-client bindings pause grabs and stop clients before any traffic leaks |
| Config invalid | Boot refuses; previous running config stays active until restart |
| Disk full | Import and transcode pause; alert event |

## 12. Observability

- Structured logs (pino, JSON) with `correlationId` propagation; log level from config.
- The event log is the primary operational record; `/activity` UI reconstructs pipelines.
- Health endpoints: `/healthz` (liveness), `/readyz` (DB + critical plugins).
- Metrics (Prometheus text endpoint, opt-in) for transcode sessions, plugin restarts, queue depths.

## 13. Deployment

- Single Docker image (Node LTS base, ffmpeg included). Volume for SQLite/config by default; `DATABASE_URL` switches to Postgres. Bare-metal documented but secondary.
- Process supervision inside the container is the kernel itself; the container runs one server process (workers are children). Restart policy belongs to the orchestrator.
- No push, release, or deployment happens without Lewis's explicit approval.

## 14. Licensing guard

Core and distributed first-party artifacts accept MIT/BSD/Apache/ISC-class dependencies only. CI generates a dependency-license report and fails on GPL/AGPL entering core artifacts. Tracker/download-client integrations talk to external tools over their APIs rather than linking GPL code.
