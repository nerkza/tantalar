# ADR-0004 — Protobuf canonical contract over gRPC Unix sockets

Status: Accepted · 2026-08-22 · Phase 0
Locked decision from the Tantalar implementation graph.

## Context

Plugins may be any language; the contract must be versioned and streaming-capable.

## Decision

Protobuf IDL is canonical. gRPC over Unix domain sockets by default; loopback TCP with a per-boot shared secret where sockets are unavailable. Packages and services use explicit semver.

## Consequences

Builders implement against this contract without inventing alternatives. Changing this decision requires a superseding ADR.
