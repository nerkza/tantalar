# ADR-0008 — Reverse-DNS event names, UUIDv7 identifiers

Status: Accepted · 2026-08-22 · Phase 0
Locked decision from the Tantalar implementation graph.

## Context

Event names must be collision-free; ids should sort by time.

## Decision

Event type names use reverse-DNS identifiers. UUIDv7 identifies events and operations.

## Consequences

Builders implement against this contract without inventing alternatives. Changing this decision requires a superseding ADR.
