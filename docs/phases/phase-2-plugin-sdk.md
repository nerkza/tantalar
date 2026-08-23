# Phase 2 — Plugin SDK & Conformance

Owner phase for stories: 23 (public contract), 24, 29 (webhook delivery as an event consumer).
Depends on: Phase 1. Enables: Phase 3a/3b.

## Scope
Freeze the public protobuf plugin contract in `packages/contracts`; ship `packages/plugin-sdk` (TS first; other languages via generated stubs); publish the conformance test suite (`packages/testkit`) that CI runs against all first-party plugins and third parties run against theirs; config-driven install/disable/swap of plugins with diff-apply mount/unmount and rollback; developer docs ("first plugin in under 30 minutes"). Also owns the dedicated MCP server plugin (`dev.tantalar.plugin.mcp`): server shell, protocol conformance, generic surface, and MCP developer documentation — contract in [mcp-server.md](../mcp-server.md), decision in [ADR-0018](../adrs/0018-mcp-server-plugin.md).

## Non-goals
No product automation logic; no marketplace/registry — install is local-path/archive + configuration only (conservative default). No domain MCP tools: later domain phases own search, request, queue, acquisition, library, playback, and administration surfaces once their capabilities exist. V1 forbids destructive MCP tools, direct file deletion, credential changes, plugin installation, configuration mutation, account administration, and unrestricted command execution.

## Contracts
- Protobuf IDL is canonical (ADR-004): manifest, capability register/deregister, event subscribe/publish, RPC services, health ping, protocol-version handshake. Breaking changes bump major.
- **Auth-introspection capability** (new in the public contract): a narrow core capability that, given a presented API-key credential, returns validity, owning identity, and granted scopes. It exists so plugins such as the MCP server can authenticate clients with no direct DB or secret-store access. Raw keys are never returned, logged, or emitted.
- MCP server (Phase 2 generic surface only): MCP Streamable HTTP on loopback by default (non-loopback requires explicit config + TLS via trusted reverse proxy); optional local stdio bridge reusing the same server implementation (no duplicated business logic); reads enabled by default, mutating tools disabled by default and requiring explicit configuration plus operation-specific scopes; every call emits an immutable audit event (`dev.tantalar.event.mcp.call`: client identity, tool/resource name, redacted arguments, outcome, correlationId, causationId); bounded timeouts, pagination, result-size limits, rate limits, cancellation, stable MCP error mapping; client disconnect cancels in-flight reads but never silently rolls back accepted mutations; MCP JSON schemas generated from canonical Tantalar runtime schemas, no duplicate hand-written domain schemas. Generic tools: health, capability discovery, activity query, operation-status query, redacted effective-config inspection.
- Semver for packages and the contract service version (ADR-004).
- Webhooks: a first-party consumer plugin translating selected reverse-DNS events to outbound HTTP POSTs with HMAC signature, scoped API key auth, bounded retries.

## Data model changes
`plugin_state` gains installed-source, enabled flag, declared capabilities snapshot. `outbound_webhooks` table (plugin-owned).

## Security constraints
Plugin processes untrusted; socket-dir permissions 0600; capability grants strictly from manifest; webhook secrets env-only.

## Acceptance criteria (exit)
An external developer builds, conforms, installs, disables, and swaps a working plugin without reading Tantalar source. Conformance suite runs in CI against every first-party plugin.

## Test plan
Conformance suite as product artifact (mount/unmount/crash/replay/idempotency cases); integration tests for config-diff lifecycle incl. rollback on failed swap; contract-version mismatch rejection test. MCP: protocol conformance, authentication (valid/invalid/scoped keys), authorization (scope enforcement, mutation gate), redaction, audit-event emission, timeout, cancellation (incl. client-disconnect-during-read), pagination, restart recovery — fixtures only.

## Acceptance evidence (MCP)
A local MCP client connects over Streamable HTTP with a scoped API key, reads health and activity successfully, attempts an unauthorized mutation and is refused, and the refused attempt plus both reads each produce an immutable audit event with client identity, tool name, redacted arguments, outcome, correlationId, and causationId.

## Rollback / migration notes
Contract freeze means later breaking changes require a major bump and a compatibility shim window; document in SDK docs.

## Exit evidence

- **Tests**: `pnpm test` → 15 files, 88 passed, 1 skipped (Postgres full-migration test runs in CI with `TANTALAR_CI_POSTGRES=1`).
- **Typecheck/build**: `pnpm run typecheck` and `pnpm run build` clean (`tsc -b`, strict ESM, NodeNext).
- Coverage of the required areas:
  - Contract + packaging security: `tests/phase2-contract-packaging.test.ts` (semver compatibility rule, path traversal, absolute paths, symlinks, duplicate members, size caps, malformed manifests, unsafe install ids, entry escaping package root, pack→verify→extract round trip).
  - Lifecycle + conformance: `tests/phase2-lifecycle-conformance.test.ts` (config-driven diff-apply mount/disable with capability revocation, id-mismatch rejection without disturbing healthy plugins, rollback on failed swap, plugin→capability invocation gate across the process boundary, event delivery to subscribed plugins, contract-version mismatch rejection; conformance testkit green against hello-world, webhook, and mcp-server).
  - MCP acceptance: `tests/phase2-mcp.test.ts` (Streamable HTTP connect with scoped API key, unauthorized read refused, audit event per call with client identity, tool name, redacted arguments, outcome, correlationId on the envelope, causationId; non-loopback bind without `tlsViaProxy` never starts the transport).
- **Developer guide**: `docs/guides/first-plugin.md` — scaffold → manifest → source → conformance → `.tpk` packaging → config-driven install/enable/disable/upgrade/rollback walkthrough targeting a first plugin in under 30 minutes.
- **CI**: `.github/workflows/ci.yml` runs typecheck, the full suite including conformance against all first-party plugins, PostgreSQL migrations, and the GPL-free license report.

Published conformance suite green in CI, external-style walkthrough doc verified by building the sample plugin from scratch, docs updated, reviewer acceptance.
