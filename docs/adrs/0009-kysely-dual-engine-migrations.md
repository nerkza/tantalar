# ADR-0009 — Kysely with SQLite and PostgreSQL

Status: Accepted · 2026-08-22 · Phase 0
Locked decision from the Tantalar implementation graph.

## Context

SQLite default, Postgres option, per PRD story 28.

## Decision

Kysely is the database abstraction; better-sqlite3 (WAL) and pg drivers. Migrations are per-dialect SQL pairs in one numbered sequence and must pass on both engines before any phase exits.

## Consequences

Builders implement against this contract without inventing alternatives. Changing this decision requires a superseding ADR.
