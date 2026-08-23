# ADR-0018 — Dedicated MCP server plugin: boundary, transport, authentication, safety model

Status: Accepted · 2026-08-22 · Design integration (post-Phase-0)
Locked decision from the Tantalar implementation graph.

## Context

Lewis wants a dedicated MCP (Model Context Protocol) server so external AI clients can operate Tantalar. It must not become a privileged side door: the architecture's core rule is that nothing bypasses the public plugin contract (ADR-004, ADR-015).

## Decision

1. **Boundary.** The MCP server is a first-party, out-of-process plugin named `dev.tantalar.plugin.mcp`, stored under `plugins/mcp-server`. It speaks only the public protobuf/gRPC plugin contract. It has no direct database, media-file, configuration-file, or secret-store access.
2. **Ownership.** Phase 2 owns the server shell, protocol conformance, generic operations, and developer documentation. Later domain phases add their own MCP tools only when their capabilities already exist in that phase. One phase owns each MCP surface.
3. **Transport.** Primary transport is MCP Streamable HTTP, bound to loopback by default. Remote or LAN binding requires explicit configuration plus TLS through a trusted reverse proxy. An optional local stdio bridge for desktop MCP clients connects to the same server implementation and never duplicates business logic.
4. **Authentication.** Clients authenticate with scoped Tantalar API keys. A narrow core auth-introspection capability is added to the public plugin contract so the plugin can validate keys and scopes without direct DB access. Raw keys never appear in tool output or logs.
5. **Safety defaults.** Read operations are enabled by default. Mutating tools are disabled by default and require explicit configuration plus operation-specific scopes. V1 forbids destructive tools, direct file deletion, credential changes, plugin installation, configuration mutation, account administration, and unrestricted command execution.
6. **Auditing.** Every MCP call emits an immutable audit event (ADR-007 envelope) containing client identity, tool or resource name, redacted arguments, outcome, `correlationId`, and `causationId`.
7. **Schemas.** MCP JSON schemas are generated from canonical Tantalar runtime schemas where possible; no duplicate hand-written domain schemas are maintained.

## Consequences

Downstream builders implement MCP tools against this contract without inventing protocol boundaries. No privileged bypass exists: the server is exactly as capable as its declared capability grants. Risky actions stay opt-in and scoped. Changing any of these points requires a superseding ADR. Full operational detail: [docs/mcp-server.md](../mcp-server.md).
