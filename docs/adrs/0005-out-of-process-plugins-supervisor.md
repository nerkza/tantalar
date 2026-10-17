# ADR-0005 — Out-of-process plugins supervised by core

Status: Accepted · 2026-08-22 · Phase 0
Locked decision from the Tantalar implementation graph.

## Context

A crashing plugin must not take down the server.

## Decision

Plugins run out-of-process. The supervisor owns start, health checks, restart policy, shutdown, and registration rollback. No plugin writes core tables directly; persistence flows through module code using packages/db.

## Consequences

Builders implement against this contract without inventing alternatives. Changing this decision requires a superseding ADR.
