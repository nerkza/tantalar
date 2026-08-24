# Wave 8 — Product UI, Settings, Library, and Player (TAN-023–029)

Card: `t_76fafcef` · Umbrella: `t_3c086a94` · 2026-08-24

## Scope delivered

- **Product information architecture.** The framework-default shell is replaced with
  Home, Movies, Series, Calendar, Activity, and Settings (`apps/web/src/App.tsx`).
  Hash routing keeps static-host compatibility. Administration remains role-gated:
  the Admin button renders only for `role === "admin"` and #/admin is unchanged.
- **Design system.** Light + dark themes over the existing `--tantalar-*` token layer.
  `LIGHT_TOKENS` added to `theme/tokens.ts`; the scheme selector persists per user via
  ui-preferences and drives both the token base and Mantine's color scheme.
- **Settings page** (`pages/SettingsPage.tsx`) with all twelve sections: General,
  Libraries, Downloads, Indexers, Quality, Import, Metadata, Playback, Users,
  Integrations, VPN, System. Real wiring: libraries list/validate/rescan/free-space,
  indexer list/test/enable (redacted records only), users create/list, catalog rows,
  plugin states, system health, theme scheme + appearance editor with human labels.
  Admin-only sections render a clear notice for viewers instead of hidden controls.
- **No internal token names as user settings.** `TOKEN_LABELS` maps every token to a
  human label ("Accent color", "Page background"); applied in both the product
  Settings page and the admin theme editor; e2e asserts raw names never appear.
- **Home and library browsing states.** Home shows continue-watching with progress
  plus an in-library row; Movies/Series catalogs add search filtering; Calendar reads
  the importer capability's monitored-media entries. Every view implements loading,
  empty, error+retry, permission-degraded states truthfully.
- **Player integration.** Existing engine retained on packaged production routes;
  added global keyboard controls (space/K play-pause, J/L/arrows ±10s seek, M mute,
  F fullscreen) that yield to form fields and sliders, an on-page shortcut hint,
  and a CSS-backed screen-reader live region (`product.css`). Direct play, HLS
  quality ladder, subtitles, resume, next-episode autoplay, error surfaces all
  carried through from Phase 5B/Wave 7 unchanged.

## Verification (independently rerunnable)

- `pnpm run typecheck` — green.
- `pnpm run build` — green.
- `pnpm run test` — 300 passed / 5 gated skips (unchanged suite).
- Web vitest: 29/29 (21 prior + 8 new `wave8-product.test.tsx`).
- Playwright: 23/23 with `--workers=1` (17 prior incl. viewer flows + 6 new
  responsive/a11y/theme tests in `e2e/product.spec.ts`).
- Visual evidence: screenshots at 320/390/768/1024/1600 widths plus light/dark
  settings, inspected by eye/vision: `/srv/projects/artifacts/wave8-*.png`.
  Mobile at 320px confirmed single-column, no horizontal overflow (asserted in test).

## Notes for review

- The old `LibraryPage.tsx` was removed; its grid lives on as the Catalog page.
- `vite.config.ts` has a pre-existing tsc noise entry (`test: undefined` key) that
  predates this card; left untouched.
- No push/deploy/release performed; Waves 2–7 work preserved.

## Residual risks

- Wide-desktop grids leave whitespace with small fixture libraries (cosmetic; real
  libraries populate more columns).
- Calendar depends on the library plugin being mounted; absent plugin degrades to a
  truthful empty state rather than an error.
