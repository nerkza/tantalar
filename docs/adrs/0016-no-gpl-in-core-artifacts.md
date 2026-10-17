# ADR-0016 — No GPL dependencies in distributed core artifacts

Status: Accepted · 2026-08-22 · Phase 0
Locked decision from the Tantalar implementation graph.

## Context

MIT core maximizes ecosystem adoption.

## Decision

Distributed core artifacts accept MIT/BSD/Apache/ISC-class dependencies only. CI generates and enforces a dependency-license report. Integrations talk to external tools over APIs, never linked GPL code.

## Consequences

Builders implement against this contract without inventing alternatives. Changing this decision requires a superseding ADR.
