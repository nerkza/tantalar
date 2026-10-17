# ADR-0013 — Testing: Vitest, fixtures, Playwright, no live indexers

Status: Accepted · 2026-08-22 · Phase 0
Locked decision from the Tantalar implementation graph.

## Context

CI must not depend on live trackers or indexers.

## Decision

Vitest for unit/contract/integration tests against fixtures; Playwright covers critical browser flows. Deep modules get behavior-level tests only, per PRD testing decisions.

## Consequences

Builders implement against this contract without inventing alternatives. Changing this decision requires a superseding ADR.
