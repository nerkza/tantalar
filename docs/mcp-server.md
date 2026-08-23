# Tantalar MCP Server — Contract

Status: Design · 2026-08-22
Decision record: [ADR-0018](adrs/0018-mcp-server-plugin.md). Owner of the server shell and generic surface: [Phase 2](phases/phase-2-plugin-sdk.md).

This document is the contract for Tantalar's dedicated MCP (Model Context Protocol) server. Downstream builders implement against it; they do not invent protocol boundaries.

## 1. Identity and boundary

- First-party, out-of-process plugin `dev.tantalar.plugin.mcp` under `plugins/mcp-server`.
- Uses the public protobuf/gRPC plugin contract only (ADR-004, ADR-015). No direct database, media-file, configuration-file, or secret-store access.
- The plugin declares its capabilities in its manifest like any other plugin; the service container resolves them strictly (ADR-0006).

## 2. Transports

| Transport | Default | Notes |
|---|---|---|
| MCP Streamable HTTP | enabled, loopback bind | Primary transport. Non-loopback binding requires explicit configuration plus TLS via a trusted reverse proxy. |
| Local stdio bridge | disabled | Optional bridge for desktop MCP clients. Connects to the same server implementation over Streamable HTTP on loopback; contains no business logic. |

## 3. Authentication and authorization

- Clients authenticate with scoped Tantalar API keys (`tantalar_…`, hashed at rest per architecture §Auth).
- The public plugin contract gains a narrow core **auth-introspection** capability: given a presented key credential, it returns validity, owning identity, and granted scopes. Nothing else.
- Raw keys never appear in tool output, resources, prompts, or logs.
- Authorization is scope-based per operation (see §4).

## 4. Tools, scopes, defaults

Default posture: **reads on, mutations off**.

| Surface | Kind | Owner phase | Default | Required scope pattern |
|---|---|---|---|---|
| health | read tool | Phase 2 | enabled | none beyond valid key |
| capability discovery | read tool | Phase 2 | enabled | none beyond valid key |
| activity query | read tool | Phase 2 | enabled | event-log read |
| operation-status query | read tool | Phase 2 | enabled | operation read |
| effective-config inspection | read tool (redacted) | Phase 2 | enabled | config read (redacted output only) |
| search / request / queue / acquisition tools | read + mutate | Phase 3a/3b | reads on; mutations off | per-operation scope (e.g. `queue:write`) |
| library tools | read + mutate | Phase 4 | reads on; mutations off | per-operation scope |
| playback tools | mutate | Phase 5 | off | playback write |
| administration tools | forbidden in v1 | — | — | — |

Rules:

- Mutating tools require explicit configuration to enable plus an operation-specific API-key scope.
- V1 forbids: destructive tools, direct file deletion, credential changes, plugin installation, configuration mutation, account administration, unrestricted command execution.
- Domain phases add their own MCP tools only when their capabilities already exist in that phase. One phase owns each surface; no cross-phase ownership.

## 5. Resources and prompts

- MCP resources may expose redacted system status, activity, queue, library, and schema data — only after the owning domain phase exists.
- Prompts are optional. Prompts must contain no hidden authority: no embedded credentials, no instruction-level capability escalation, no bypass of scopes or confirmation settings.

## 6. Schemas

MCP JSON schemas are generated from canonical Tantalar runtime schemas (TypeBox/protobuf sources) where possible. Hand-written domain schemas are not maintained; generation is part of each owning phase's build.

## 7. Operational limits and error mapping

Every tool call applies:

- bounded timeouts,
- pagination with cursor + page size limits,
- result-size limits,
- rate limits per client key,
- cancellation support,
- stable MCP error mapping (tool errors map to a fixed error-code set; internal details are never leaked).

Disconnect semantics: a client disconnect cancels safe in-flight **reads** but must **not** silently roll back accepted **mutations** — mutations report their outcome as an audit event regardless of disconnect.

## 8. Auditing

Every MCP call emits one immutable audit event using the standard envelope (ADR-007):

```
type: dev.tantalar.event.mcp.call
payload fields:
  clientIdentity, toolOrResourceName, redactedArguments,
  outcome, correlationId, causationId
```

Events are append-only; redaction follows the same rules as `--dump-config`. Audit coverage for MCP calls is part of each phase's exit criteria.

## 9. Configuration

Layered YAML keys under `mcp:` (redacted in dumps like all config):

```yaml
mcp:
  http:
    enabled: true
    bind: "127.0.0.1"     # non-loopback requires explicit override
    port: 8642
    tlsViaProxy: true     # required true for any non-loopback bind
  stdioBridge:
    enabled: false
  mutatingToolsEnabled: false   # global gate; per-tool scopes still apply
  limits:
    timeoutMs: 30000
    maxResultBytes: 1048576
    rateLimitPerMinute: 120
```

## 10. Extension rules

1. New domain tools belong to the phase that owns the underlying capability.
2. Tool names follow reverse-DNS-derived naming consistent with capability naming (ADR-0006).
3. Every new tool registers: scopes, default state (read/mutate), schema source, audit mapping, limit profile.
4. Breaking changes to this contract follow the same major-bump rule as the plugin contract (ADR-004).
5. This file is normative; conflicting prose elsewhere is superseded by ADR-0018 plus this document.

## 11. Test requirements (fixtures only)

Each owning phase runs: protocol conformance, authentication, authorization/scope enforcement, redaction, audit-event emission, timeout, cancellation (including disconnect-during-read), pagination, restart-recovery, and MCP conformance-suite tests. All tests use fixtures; no live external services.
