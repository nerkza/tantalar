# ADR-0006 — Manifest-declared capabilities, reverse-DNS names

Status: Accepted · 2026-08-22 · Phase 0
Locked decision from the Tantalar implementation graph.

## Context

Dependency wiring must be explicit and fail loudly.

## Decision

Service container resolves manifest-declared capabilities named with reverse-DNS identifiers (e.g. dev.tantalar.capability.downloader). Resolution fails hard on missing or ambiguous providers.

## Consequences

Builders implement against this contract without inventing alternatives. Changing this decision requires a superseding ADR.
