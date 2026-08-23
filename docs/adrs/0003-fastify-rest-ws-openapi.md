# ADR-0003 — Fastify REST/WebSocket, generated OpenAPI

Status: Accepted · 2026-08-22 · Phase 0
Locked decision from the Tantalar implementation graph.

## Context

The server needs REST and WS APIs plus API docs that cannot drift.

## Decision

Fastify serves REST and WebSocket endpoints. OpenAPI is generated at runtime from the same schemas (TypeBox) that validate requests. No hand-written OpenAPI.

## Consequences

Builders implement against this contract without inventing alternatives. Changing this decision requires a superseding ADR.
