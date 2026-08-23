# ADR-0002 — Node LTS, TypeScript strict, ESM

Status: Accepted · 2026-08-22 · Phase 0
Locked decision from the Tantalar implementation graph.

## Context

PRD allows Bun if it proves stable for ffmpeg orchestration.

## Decision

Conservative: Node LTS only for v1, no Bun. TypeScript strict mode; ESM packages throughout. Revisit Bun only via a superseding ADR with v1 evidence.

## Consequences

Builders implement against this contract without inventing alternatives. Changing this decision requires a superseding ADR.
