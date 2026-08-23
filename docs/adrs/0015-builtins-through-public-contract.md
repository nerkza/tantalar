# ADR-0015 — Built-ins use the public plugin contract

Status: Accepted · 2026-08-22 · Phase 0
Locked decision from the Tantalar implementation graph.

## Context

No privileged kernel; community and first-party code identical.

## Decision

Core contains no tracker-specific, downloader-specific, media-provider-specific, or UI-module business logic. First-party functionality mounts through the public contract used by third-party plugins.

## Consequences

Builders implement against this contract without inventing alternatives. Changing this decision requires a superseding ADR.
