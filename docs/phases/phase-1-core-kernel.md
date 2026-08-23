# Phase 1 — Core Kernel

Owner phase for stories: 22, 23 (runtime), 29 (API keys), 30.
Depends on: Phase 0. Enables: everything.

## Status: implemented — pending reviewer acceptance

## Scope
Bootable server: layered config (`packages/config`), Kysely persistence with SQLite+Postgres migrations (`packages/db`), append-only event log + typed event bus, service container with reverse-DNS capabilities, plugin supervisor (spawn/handshake/health/restart/unmount rollback), scheduler with persisted job state, auth (Argon2id, opaque sessions, CSRF, hashed scoped API keys), Fastify REST `/api/v1` + WS `/api/v1/events` feed with runtime-generated OpenAPI, structured logging, health endpoints, license-report CI job.

## Non-goals
No product plugins beyond a hello-world test fixture; no protobuf contract freeze (Phase 2); no web UI beyond a placeholder page; no streaming.

## Inputs
Locked decisions ADR-001…017; contracts package skeleton from Phase 0.

## Contracts
- Event envelope fields per ADR-007; UUIDv7 ids (ADR-008).
- Plugin transport: gRPC over Unix socket, loopback-TCP fallback with per-boot shared secret (ADR-004). Phase 1 implements the same message contract over stdio framing; the Unix-socket/loopback-TCP transport lands with the Phase 2 contract freeze. Crash isolation is identical (out-of-process child).
- Capability resolution fails hard on missing/ambiguous providers (ADR-006).
- Boot ordering: config → DB migrate → event log → container → supervisor → HTTP.

## Data model changes (initial schema)
`users`, `sessions`, `api_keys`, `events`, `scheduler_jobs`, `plugin_state`, `schema_migrations`. Dual-dialect SQL migrations.

## Security constraints
Argon2id hashes only; session tokens opaque and server-side; cookies Secure/HttpOnly/SameSite=Lax; CSRF double-submit; API keys stored SHA-256-hashed with scope lists; all mutations authenticated.

## Acceptance criteria (exit)
A hello-world out-of-process plugin mounts via manifest, provides a capability, emits events through the bus into the log, survives kill -9 with policy-driven restart, unmounts reversibly, and its activity reconstructs from the event-log replay API. Migrations pass on both engines.

## Test plan
Vitest unit (config merge/redaction, container resolution failures, envelope validation); integration (boot sequence against temp SQLite + Postgres, mount/crash/restart lifecycle with fixture plugin over real process boundary); security tests (auth boundaries, CSRF rejection, key scoping).

## Rollback / migration notes
Initial schema; forward-only migrations. Config schema versioned; unknown-key warnings keep older configs loadable.

## Exit evidence

- **Tests**: `pnpm test` → 10 files, 53 passed, 1 skipped (Postgres full-migration test runs in CI with `TANTALAR_CI_POSTGRES=1`; the loud-failure path is covered locally).
- **Typecheck**: `pnpm run typecheck` clean (`tsc -b`, strict ESM, NodeNext).
- Coverage of the required areas:
  - Auth boundaries: `tests/auth.test.ts`, `tests/http.test.ts` (login/logout/session expiry/API-key scopes/CSRF rejection).
  - Configuration precedence & redaction: `tests/config.test.ts` (defaults → profile → host → CLI, list `+` append, env secrets redacted in `--dump-config`, dump is a valid input layer).
  - Migrations on SQLite: `tests/migrations.test.ts`; PostgreSQL: `tests/migrations-postgres.test.ts` (CI) plus loud-failure check.
  - Event replay/idempotency: `tests/events.test.ts` (append-before-fan-out, duplicate-id no-op, replay by time/type/subject/correlation/cursor, failing subscriber isolation, no update/delete API).
  - Lifecycle rollback & crash recovery: `tests/supervisor.test.ts` (mount failure rollback, capability resolution across process boundary, kill -9 → policy restart, reversible unmount, event-log reconstruction, failed state after restart window).
  - Scheduler persistence: `tests/scheduler.test.ts` (idempotency keys, single-fire ticks, lock release, job cleanup on unmount).
  - API/WebSocket behaviour: `tests/http.test.ts` (REST surface, cookie flags, WS feed route registered), OpenAPI served at `/openapi.json`.
  - Boot sequence: `tests/kernel.test.ts` (config → migrate → log → container → supervisor → HTTP, boot event, idempotent re-boot, dump-config round trip).
- **CI**: `.github/workflows/ci.yml` — typecheck, tests on SQLite, PostgreSQL service migration job, GPL-free license report (ADR-016).
