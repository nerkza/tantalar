# ADR-0011 — Auth: Argon2id, opaque sessions, CSRF, hashed API keys

Status: Accepted · 2026-08-22 · Phase 0
Locked decision from the Tantalar implementation graph.

## Context

Admin and viewer accounts need simple but correct web auth.

## Decision

Argon2id password hashes; opaque server-side session tokens in Secure HttpOnly SameSite=Lax cookies; CSRF double-submit protection; scoped API keys stored SHA-256-hashed.

## Consequences

Builders implement against this contract without inventing alternatives. Changing this decision requires a superseding ADR.
