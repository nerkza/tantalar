/**
 * Theme engine (story 26): applies the shared `--tantalar-*` token layer to
 * the document, previews overrides live, and persists the active theme via
 * per-user UI preferences + the themes table. Preview state is separate from
 * saved state so "revert" is always possible without a reload.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useMantineColorScheme } from "@mantine/core";
import {
  applyTokens,
  sanitizeTokenOverrides,
  LIGHT_TOKENS,
  type ThemeScheme,
  type TokenMap,
} from "./tokens";
import { api, type TrajectoryEvent } from "../api";

export interface SavedTheme {
  readonly id: string;
  readonly name: string;
  readonly tokens: TokenMap;
}

interface ThemeContextValue {
  /** Saved (persisted) overrides, or null while loading. */
  saved: TokenMap | null;
  /** Live preview overrides currently applied on top of saved. */
  preview: TokenMap | null;
  themes: readonly SavedTheme[];
  activeThemeId: string | null;
  /** Built-in light/dark scheme (wave 8); persisted per user. */
  scheme: ThemeScheme;
  setScheme: (scheme: ThemeScheme) => void;
  applyPreview: (tokens: Record<string, string>) => { ok: boolean; errors?: string[] };
  clearPreview: () => void;
  /** Persist preview (or explicit tokens) as the user's theme + preference. */
  save: (name: string, tokens: TokenMap) => Promise<void>;
  /** Drop preview and re-apply the last saved state. */
  revert: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme outside ThemeEngineProvider");
  return ctx;
}

export function ThemeEngineProvider({ children, adminId }: { children: React.ReactNode; adminId: string | null }) {
  const [saved, setSaved] = useState<TokenMap | null>(null);
  const [preview, setPreview] = useState<TokenMap | null>(null);
  const [themes, setThemes] = useState<readonly SavedTheme[]>([]);
  const [activeThemeId, setActiveThemeId] = useState<string | null>(null);
  // Wave 8: built-in light/dark scheme. Dark stays the product default.
  const [scheme, setSchemeState] = useState<ThemeScheme>("dark");
  const { setColorScheme } = useMantineColorScheme();
  // Latest known grid prefs, so a theme save can merge instead of clobbering
  // them with hardcoded defaults (review finding on parent t_89f131b7).
  const gridPrefsRef = useRef<{ gridDensity?: string; hiddenColumns?: string[] }>({});

  // Load saved preferences + theme catalogue once.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const prefs: Record<string, unknown> = adminId
        ? await api.uiPreferences(adminId).then((r) => r.preferences).catch(() => ({}) as Record<string, unknown>)
        : {};
      const catalogue = await api.themes().then((r) => r.themes).catch(() => []);
      if (cancelled) return;
      setThemes(catalogue);
      gridPrefsRef.current = {
        gridDensity: typeof prefs.gridDensity === "string" ? prefs.gridDensity : undefined,
        hiddenColumns: Array.isArray(prefs.hiddenColumns) ? (prefs.hiddenColumns as string[]) : undefined,
      };
      const themeId = typeof prefs.themeId === "string" ? prefs.themeId : null;
      const overrides = (prefs.tokenOverrides && typeof prefs.tokenOverrides === "object")
        ? (prefs.tokenOverrides as TokenMap)
        : {};
      if (prefs.colorScheme === "light" || prefs.colorScheme === "dark") {
        setSchemeState(prefs.colorScheme);
        setColorScheme(prefs.colorScheme);
      }
      setActiveThemeId(themeId);
      setSaved(overrides);
    })();
    return () => {
      cancelled = true;
    };
  }, [adminId]);

  // Apply saved + preview to :root whenever either changes. The scheme is a
  // base palette: light swaps in the light token set under any overrides.
  useEffect(() => {
    const base: TokenMap = scheme === "light" ? { ...LIGHT_TOKENS } : {};
    applyTokens(document.documentElement, { ...base, ...(saved ?? {}), ...(preview ?? {}) });
  }, [saved, preview, scheme]);

  /** Switch the built-in scheme and persist the choice per user. */
  const setScheme = useCallback(
    (next: ThemeScheme) => {
      setSchemeState(next);
      setColorScheme(next);
      if (adminId) {
        void api
          .uiPreferences(adminId)
          .then((r) => api.saveUiPreferences(adminId, { ...r.preferences, colorScheme: next }))
          .catch(() => undefined);
      }
    },
    [adminId, setColorScheme],
  );

  const applyPreview = useCallback((tokens: Record<string, string>) => {
    const result = sanitizeTokenOverrides(tokens);
    if (!result.ok) return { ok: false as const, errors: result.errors };
    setPreview(result.tokens);
    return { ok: true as const };
  }, []);

  const clearPreview = useCallback(() => setPreview(null), []);

  const revert = useCallback(() => {
    setPreview(null);
    applyTokens(document.documentElement, saved ?? {});
  }, [saved]);

  const save = useCallback(
    async (name: string, tokens: TokenMap) => {
      const merged: TokenMap = { ...(saved ?? {}), ...tokens };
      // Persist as a named theme, then point the user's preference at it and
      // store the raw overrides so the tokens survive theme deletion.
      const created = await api.saveTheme(null, name, merged as Record<string, string>);
      const themeId = (created as { theme?: { id?: string } }).theme?.id ?? null;
      if (adminId) {
        // Merge with the latest known grid prefs — never overwrite them
        // with hardcoded defaults (review defect: density reset on save).
        const grid = gridPrefsRef.current;
        await api.saveUiPreferences(adminId, {
          themeId,
          tokenOverrides: merged,
          ...(grid.gridDensity !== undefined ? { gridDensity: grid.gridDensity } : {}),
          ...(grid.hiddenColumns !== undefined ? { hiddenColumns: [...grid.hiddenColumns] } : {}),
        });
      }
      setSaved(merged);
      setPreview(null);
      setActiveThemeId(themeId);
      const catalogue = await api.themes().then((r) => r.themes).catch(() => []);
      setThemes(catalogue);
    },
    [adminId, saved],
  );

  const value = useMemo<ThemeContextValue>(
    () => ({ saved, preview, themes, activeThemeId, scheme, setScheme, applyPreview, clearPreview, save, revert }),
    [saved, preview, themes, activeThemeId, scheme, setScheme, applyPreview, clearPreview, save, revert],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/** Fetch events for the Activity/Trajectory view. */
export function fetchTrajectoryEvents(
  filters: { typePrefix?: string; subject?: string; correlationId?: string; limit?: number },
): Promise<{ events: TrajectoryEvent[] }> {
  return api.events(filters);
}
