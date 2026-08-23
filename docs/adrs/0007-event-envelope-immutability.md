# ADR-0007 — Event envelope shape and immutability

Status: Accepted · 2026-08-22 · Phase 0
Locked decision from the Tantalar implementation graph.

## Context

Every operation must be traceable and replay-safe.

## Decision

Envelopes contain schemaVersion, eventId, type, occurredAt, producer, subject, correlationId, causationId, payload, metadata. Events are immutable after append. Consumers must be idempotent. Append precedes fan-out.

## Consequences

Builders implement against this contract without inventing alternatives. Changing this decision requires a superseding ADR.
