/**
 * Tantalar design tokens (phase 6, stories 25–26).
 *
 * The single source of token truth: every visual decision in the admin and
 * player UIs reads a `--tantalar-*` CSS variable. Tokens are published as
 * defaults here, applied to :root at runtime by the theme engine, and can be
 * overridden per user through the settings theme editor (persisted server
 * side). Components must never hardcode colors or spacing.
 */

export type TokenMap = Readonly<Record<string, string>>;

export const TOKEN_PREFIX = "--tantalar-";

/** Canonical default palette. Keys are WITHOUT the --tantalar- prefix. */
export const DEFAULT_TOKENS: TokenMap = {
  "color-bg": "#10121a",
  "color-surface": "#191c27",
  "color-surface-raised": "#222634",
  "color-text": "#eef0f6",
  "color-text-dimmed": "#9aa0b4",
  "color-primary": "#4d8df6",
  "color-primary-contrast": "#ffffff",
  "color-danger": "#e5484d",
  "color-success": "#46a758",
  "color-warning": "#f5a524",
  "color-border": "#2c3143",
  "space-unit": "4px",
  "radius-md": "8px",
  "font-size-base": "15px",
};

export function fullTokenName(key: string): string {
  return `${TOKEN_PREFIX}${key}`;
}

/**
 * Wave 8: light scheme palette. Same token keys as the dark defaults so a
 * theme switch is only ever a different override set, never new variable
 * names. The UI offers "Light" and "Dark" by these human names; the internal
 * `--tantalar-*` identifiers never appear as user-facing settings.
 */
export const LIGHT_TOKENS: TokenMap = {
  "color-bg": "#f5f6fa",
  "color-surface": "#ffffff",
  "color-surface-raised": "#ffffff",
  "color-text": "#1a1c26",
  "color-text-dimmed": "#5b6070",
  "color-primary": "#2f6fd8",
  "color-primary-contrast": "#ffffff",
  "color-danger": "#d13438",
  "color-success": "#2e7d43",
  "color-warning": "#b97a0a",
  "color-border": "#d8dbe4",
};

export type ThemeScheme = "dark" | "light";

/** Human-readable names for the built-in schemes (never raw token names). */
export const SCHEME_LABELS: Record<ThemeScheme, string> = {
  dark: "Dark",
  light: "Light",
};

/**
 * Human-readable names for every token key. Settings UIs show these labels;
 * the raw `--tantalar-*` identifiers are internal and never user-facing.
 */
export const TOKEN_LABELS: Record<string, string> = {
  "color-bg": "Page background",
  "color-surface": "Card background",
  "color-surface-raised": "Raised surface",
  "color-text": "Text",
  "color-text-dimmed": "Secondary text",
  "color-primary": "Accent color",
  "color-primary-contrast": "Text on accent",
  "color-danger": "Error color",
  "color-success": "Success color",
  "color-warning": "Warning color",
  "color-border": "Borders",
  "space-unit": "Spacing unit",
  "radius-md": "Corner radius",
  "font-size-base": "Base font size",
};

const VALUE_RE = /^[#%(),.\s/a-z0-9-]{0,120}$/i;
const FORBIDDEN_RE = /(url\s*\(|expression|@import|@media|javascript:|<|>|;|\\|\{|\})/i;
const NAME_RE = /^[a-z0-9-]+$/;

/**
 * Sanitize a user-supplied token override set (theme editor input).
 * Only `--tantalar-*` token names with safe value characters pass; anything
 * that could smuggle script execution, an at-rule, or a URL is rejected so
 * the caller can show a validation error instead of silently dropping it.
 */
export function sanitizeTokenOverrides(
  input: Record<string, string>,
): { ok: true; tokens: TokenMap } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const tokens: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(input)) {
    const name = key.startsWith(TOKEN_PREFIX) ? key.slice(TOKEN_PREFIX.length) : key;
    const value = String(rawValue ?? "").trim();
    if (!NAME_RE.test(name)) {
      errors.push(`invalid token name "${name}"`);
      continue;
    }
    if (!value || FORBIDDEN_RE.test(value) || !VALUE_RE.test(value)) {
      errors.push(`unsafe value for token "${name}"`);
      continue;
    }
    tokens[name] = value;
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, tokens };
}

/** Build the complete CSS variable declaration block for a token set. */
export function tokensToCssVariables(overrides?: TokenMap | null): string {
  const merged: TokenMap = { ...DEFAULT_TOKENS, ...(overrides ?? {}) };
  return Object.entries(merged)
    .map(([k, v]) => `${fullTokenName(k)}:${v}`)
    .join(";");
}

/** Apply tokens to an element (typically document.documentElement). */
export function applyTokens(element: HTMLElement, overrides?: TokenMap | null): void {
  const merged: TokenMap = { ...DEFAULT_TOKENS, ...(overrides ?? {}) };
  // Reset any previously applied override keys not present anymore.
  const style = element.style;
  for (let i = style.length - 1; i >= 0; i--) {
    const prop = style.item(i);
    if (prop?.startsWith(TOKEN_PREFIX) && !(prop.slice(TOKEN_PREFIX.length) in merged)) {
      style.removeProperty(prop);
    }
  }
  for (const [k, v] of Object.entries(merged)) {
    style.setProperty(fullTokenName(k), v);
  }
}
