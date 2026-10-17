# ADR-0012 — Web UI: React, Mantine, TanStack stack

Status: Accepted · 2026-08-22 · Phase 0
Locked decision from the Tantalar implementation graph.

## Context

Dense management grids and theming from day one.

## Decision

React + Mantine + TanStack Router + TanStack Query + TanStack Table. Shared design tokens are CSS variables (--tantalar-*); components never hardcode visual values.

## Consequences

Builders implement against this contract without inventing alternatives. Changing this decision requires a superseding ADR.
