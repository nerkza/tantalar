# Contributing to Tantalar

Thank you for your interest in contributing.

## Ground rules

- Tantalar is MIT licensed. By opening a pull request you agree that your
  contribution is licensed under the same license.
- Core artifacts must stay free of GPL/AGPL code (ADR-016). CI enforces this
  with a dependency-license report.
- Every new operation must append an event to the event log. This is a
  standing rule from the PRD and the phase documents.
- Database migrations must stay green on both SQLite and PostgreSQL (ADR-009).

## Development setup

Prerequisites: Node.js >= 22, pnpm 11, ffmpeg on PATH for serving tests,
Docker for container work.

```sh
pnpm install
pnpm run typecheck
pnpm run test            # unit + integration (SQLite)
pnpm run build
```

Web app tests: `pnpm --filter @tantalar/web test`
End-to-end: `pnpm exec playwright test`

## Pull requests

1. Keep changes focused. One concern per pull request.
2. Add or update tests for any behaviour change.
3. Run typecheck, tests, and build locally before pushing.
4. Update `docs/traceability.md` if the change affects a PRD story.

## Reporting issues

Use the issue tracker. For security vulnerabilities, follow
[SECURITY.md](SECURITY.md) — do not open a public issue.
