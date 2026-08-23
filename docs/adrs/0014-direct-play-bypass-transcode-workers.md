# ADR-0014 — Direct play bypasses ffmpeg; bounded HLS workers

Status: Accepted · 2026-08-22 · Phase 0
Locked decision from the Tantalar implementation graph.

## Context

Direct-play first; transcoding must not exhaust the host.

## Decision

Direct play streams file bytes without ffmpeg. Transcoding uses per-session ffmpeg HLS workers with bounded caps (count/CPU/memory/disk), cleanup policies, hang watchdogs, and restart orphan reaping.

## Consequences

Builders implement against this contract without inventing alternatives. Changing this decision requires a superseding ADR.
