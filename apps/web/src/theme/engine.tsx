/**
 * Theme engine (story 26): applies the shared `--tantalar-*` token layer to
 * the document, previews overrides live, and persists the active theme via
 * per-user UI preferences + the themes table. Preview state is separate from
 * saved state so "revert" is always possible without a reload.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useMantineColorScheme } from "@mantine/core";
import {
  applyTokens,
  resolveThemeTokens,
  sanitizeTokenOverrides,
  TOKEN_PREFIX,
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
  /** Activate an existing saved theme for the current user. */
  activate: (themeId: string) => Promise<void>;
  /** Apply a built-in complete palette without creating a saved-theme record. */
  activatePreset: (scheme: ThemeScheme, tokens: TokenMap) => Promise<void>;
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

  // Load saved preferences + theme catalogue once.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const prefs: Record<string, unknown> = adminId
        ? await api.uiPreferences(adminId).then((r) => r.preferences).catch(() => ({}) as Record<string, unknown>)
        : {};
      const catalogue = await api.themes().then((r) => r.themes).catch(() => []);
      if (cancelled) return;
      setThemes(catalogue.flatMap((theme) => {
        const checked = sanitizeTokenOverrides(theme.tokens);
        return checked.ok ? [{ ...theme, tokens: checked.tokens }] : [];
      }));
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
    applyTokens(document.documentElement, resolveThemeTokens(scheme, saved, preview));
  }, [saved, preview, scheme]);

  /** Switch the built-in scheme and persist the choice per user. */
  const setScheme = useCallback(
    (next: ThemeScheme) => {
      setSchemeState(next);
      setColorScheme(next);
      setSaved({});
      setPreview(null);
      setActiveThemeId(null);
      if (adminId) {
        void api
          .saveUiPreferences(adminId, {
            colorScheme: next,
            themeId: null,
            tokenOverrides: {},
          })
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
    applyTokens(document.documentElement, resolveThemeTokens(scheme, saved));
  }, [saved, scheme]);

  const save = useCallback(
    async (name: string, tokens: TokenMap) => {
      const merged: TokenMap = { ...(saved ?? {}), ...tokens };
      // Persist as a named theme, then point the user's preference at it and
      // store the raw overrides so the tokens survive theme deletion.
      const created = await api.saveTheme(
        null,
        name,
        Object.fromEntries(Object.entries(merged).map(([key, value]) => [`${TOKEN_PREFIX}${key}`, value])),
      );
      const themeId = (created as { theme?: { id?: string } }).theme?.id ?? null;
      if (adminId) {
        await api.saveUiPreferences(adminId, {
          themeId,
          tokenOverrides: merged,
          colorScheme: scheme,
        });
      }
      setSaved(merged);
      setPreview(null);
      setActiveThemeId(themeId);
      const catalogue = await api.themes().then((r) => r.themes).catch(() => []);
      setThemes(catalogue.flatMap((theme) => {
        const checked = sanitizeTokenOverrides(theme.tokens);
        return checked.ok ? [{ ...theme, tokens: checked.tokens }] : [];
      }));
    },
    [adminId, saved, scheme],
  );

  const activate = useCallback(
    async (themeId: string) => {
      const selected = themes.find((theme) => theme.id === themeId);
      if (!selected) throw new Error("Saved theme not found.");
      if (adminId) {
        await api.saveUiPreferences(adminId, {
          themeId,
          tokenOverrides: selected.tokens,
          colorScheme: scheme,
        });
      }
      setSaved(selected.tokens);
      setPreview(null);
      setActiveThemeId(themeId);
    },
    [adminId, scheme, themes],
  );

  const activatePreset = useCallback(
    async (nextScheme: ThemeScheme, tokens: TokenMap) => {
      const checked = sanitizeTokenOverrides(tokens as Record<string, string>);
      if (!checked.ok) throw new Error(checked.errors.join(" "));
      if (adminId) {
        await api.saveUiPreferences(adminId, {
          colorScheme: nextScheme,
          themeId: null,
          tokenOverrides: checked.tokens,
        });
      }
      setSchemeState(nextScheme);
      setColorScheme(nextScheme);
      setSaved(checked.tokens);
      setPreview(null);
      setActiveThemeId(null);
    },
    [adminId, setColorScheme],
  );

  const value = useMemo<ThemeContextValue>(
    () => ({ saved, preview, themes, activeThemeId, scheme, setScheme, applyPreview, clearPreview, save, activate, activatePreset, revert }),
    [saved, preview, themes, activeThemeId, scheme, setScheme, applyPreview, clearPreview, save, activate, activatePreset, revert],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/** Fetch events for the Activity/Trajectory view. */
export function fetchTrajectoryEvents(
  filters: { typePrefix?: string; subject?: string; correlationId?: string; limit?: number },
): Promise<{ events: TrajectoryEvent[] }> {
  return api.events(filters);
}
