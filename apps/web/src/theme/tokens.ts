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
