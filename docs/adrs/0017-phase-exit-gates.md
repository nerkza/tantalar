# ADR-0017 — Phase exit gates

Status: Accepted · 2026-08-22 · Phase 0
Locked decision from the Tantalar implementation graph.

## Context

Drift between docs, traceability, and behavior must be caught per phase.

## Decision

Each phase exits only after green tests, fresh reviewer acceptance, traceability updates, event-log coverage for new operations, and current docs.

## Consequences

Builders implement against this contract without inventing alternatives. Changing this decision requires a superseding ADR.
