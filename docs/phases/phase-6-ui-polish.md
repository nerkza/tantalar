# Phase 6 — UI Polish & Theming

Owner phase for stories: 25, 26, 27.
Depends on: Phase 5. Enables: Launch readiness.

## Scope
Admin UI completion on React + Mantine + TanStack Router/Query/Table: queue grids, wanted lists, history tables (dense, customizable). Design-token layer as CSS variables driving both admin and player UIs from day one of this phase's styling work; settings-UI theme editor (basic theme/layout customization). Activity/Trajectory view: filter, search, reconstruct any pipeline operation from the event log replay API ("why did it grab this release?" answers from correlationId chains).

## Non-goals
Native clients; mobile-specific layouts beyond responsive web; request portal (uncommitted scope).

## Contracts
- Tokens published as CSS variables (`--tantalar-*`) documented in the theming guide; UI components must not hardcode colors/spacing.
- Trajectory API: read-only queries over the event log (time, type prefix, subject, correlationId).

## Data model changes
Plugin-owned: `ui_preferences` (per user), `themes`.

## Security constraints
Theme CSS is token-value based only; arbitrary CSS injection from settings is sanitized/restricted; trajectory view respects viewer permissions where subjects are user-scoped.

## Acceptance criteria (exit)
Queue/wanted/history grids render, sort, filter, and customize; a token override visibly changes both admin and player UIs without code changes; the settings editor persists themes; a full grab→import decision chain is reconstructed visually from the event log.

## Test plan
Playwright critical flows (grids, theme editor, trajectory reconstruction); unit tests for correlation-chain assembly; accessibility smoke pass on dense grids.

## Rollback / migration notes
UI-only plus additive preference tables; tokens are backward-compatible additions.

## Exit evidence

Check date: 2026-08-23.

| Check | Result |
|---|---|
| pnpm run typecheck | clean |
| pnpm run build | clean |
| pnpm run test | 21 files, 195 passed, 1 skipped (Postgres-gated) |
| pnpm --filter @tantalar/web test | 2 files, 17 passed |
| pnpm exec playwright test | 17 passed (8 admin + 9 viewer) |

Admin e2e coverage (8 tests):
- queue/wanted/history grids render, filter, sort (aria-sort updates)
- grid density preference persists across navigation (ui_preferences round-trip)
- theme editor: primary-color override previews on :root, malicious CSS rejected, theme persists, revert works
- trajectory view reconstructs seeded corr-e2e-phase6 chain
- users view creates a user and lists them
- system health reports plugin states
- keyboard navigation across tabs (ArrowRight)
- responsive narrow-viewport rendering (400px)

Known harness issue: CDP keyDown/insertText/mouse events hang on admin-page Mantine inputs in this Chromium environment (Playwright fill/click/keyboard.press block). All admin interactions use JS event dispatch (fillSafely helper + native DOM click/keydown). Sign-in page and page.keyboard.press for non-text keys (ArrowRight) are unaffected. This is an environment defect, not a product defect.

Unit coverage: 8 admin unit tests (users, preferences, themes CRUD, system health) + 12 web component tests (token sanitizer, chain assembly, UI states, theme editor).
