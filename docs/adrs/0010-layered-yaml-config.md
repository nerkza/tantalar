# ADR-0010 — Layered YAML configuration

Status: Accepted · 2026-08-22 · Phase 0
Locked decision from the Tantalar implementation graph.

## Context

Config must compose across defaults, machines, and CLI without leaking secrets.

## Decision

YAML layered: defaults -> profile -> host -> CLI flags. Env vars supply secrets only. --dump-config prints the effective tree with secrets redacted; dumped output is valid as an input layer. Unknown keys warn.

## Consequences

Builders implement against this contract without inventing alternatives. Changing this decision requires a superseding ADR.
