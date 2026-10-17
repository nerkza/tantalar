# ADR-0001 — Single pnpm workspace monorepo

Status: Accepted · 2026-08-22 · Phase 0
Locked decision from the Tantalar implementation graph.

## Context

Multiple apps and packages share contracts and types.

## Decision

One pnpm workspace; packages: apps/server, apps/web, packages/contracts, packages/plugin-sdk, packages/testkit, packages/config, packages/db, plugins/*. Single lockfile; strict internal dependency rule.

## Consequences

Builders implement against this contract without inventing alternatives. Changing this decision requires a superseding ADR.
