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
  "color-primary-contrast": "#10121a",
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
  "color-primary": "#2864c7",
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

/** Resolve the same complete palette used by the live document. */
export function resolveThemeTokens(
  scheme: ThemeScheme,
  saved?: TokenMap | null,
  preview?: TokenMap | null,
): TokenMap {
  return {
    ...DEFAULT_TOKENS,
    ...(scheme === "light" ? LIGHT_TOKENS : {}),
    ...(saved ?? {}),
    ...(preview ?? {}),
  };
}

export interface BuiltInTheme {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly scheme: ThemeScheme;
  readonly tokens: TokenMap;
}

/** Complete accessible palettes. Presets never mix Accent with page surfaces. */
export const BUILT_IN_THEMES: readonly BuiltInTheme[] = [
  {
    id: "midnight-blue",
    name: "Midnight blue",
    description: "Cool dark blue",
    scheme: "dark",
    tokens: { ...DEFAULT_TOKENS },
  },
  {
    id: "graphite",
    name: "Graphite",
    description: "Neutral dark grey",
    scheme: "dark",
    tokens: {
      ...DEFAULT_TOKENS,
      "color-bg": "#121212", "color-surface": "#1c1c1c", "color-surface-raised": "#262626",
      "color-text": "#f2f2f2", "color-text-dimmed": "#a7a7a7", "color-primary": "#8ab4f8",
      "color-primary-contrast": "#121212", "color-danger": "#ff7b82", "color-success": "#6bd89a",
      "color-warning": "#f5c46b", "color-border": "#3a3a3a",
    },
  },
  {
    id: "violet-night",
    name: "Violet night",
    description: "Muted violet dark",
    scheme: "dark",
    tokens: {
      ...DEFAULT_TOKENS,
      "color-bg": "#15111c", "color-surface": "#201829", "color-surface-raised": "#2b2136",
      "color-text": "#f4eef8", "color-text-dimmed": "#b6a8c2", "color-primary": "#c5a3ff",
      "color-primary-contrast": "#15111c", "color-danger": "#ff7f92", "color-success": "#79d9a4",
      "color-warning": "#f2c96d", "color-border": "#463753",
    },
  },
  {
    id: "forest",
    name: "Forest",
    description: "Low-light green",
    scheme: "dark",
    tokens: {
      ...DEFAULT_TOKENS,
      "color-bg": "#0d1713", "color-surface": "#15231d", "color-surface-raised": "#1e3028",
      "color-text": "#edf6f1", "color-text-dimmed": "#9fb6aa", "color-primary": "#71d6a3",
      "color-primary-contrast": "#0d1713", "color-danger": "#ff8585", "color-success": "#71d6a3",
      "color-warning": "#e9c46a", "color-border": "#30483d",
    },
  },
  {
    id: "amber-terminal",
    name: "Amber terminal",
    description: "Warm low-light amber",
    scheme: "dark",
    tokens: {
      ...DEFAULT_TOKENS,
      "color-bg": "#17130c", "color-surface": "#241d12", "color-surface-raised": "#302719",
      "color-text": "#fff4df", "color-text-dimmed": "#c2ad86", "color-primary": "#f3bd63",
      "color-primary-contrast": "#17130c", "color-danger": "#ff8585", "color-success": "#7fd39b",
      "color-warning": "#f3bd63", "color-border": "#4c3b22",
    },
  },
  {
    id: "high-contrast-dark",
    name: "High contrast dark",
    description: "Maximum dark clarity",
    scheme: "dark",
    tokens: {
      ...DEFAULT_TOKENS,
      "color-bg": "#08090c", "color-surface": "#111318", "color-surface-raised": "#1c2027",
      "color-text": "#ffffff", "color-text-dimmed": "#c4cad4", "color-primary": "#7eb3ff",
      "color-primary-contrast": "#08090c", "color-danger": "#ff8b91", "color-success": "#75dda2",
      "color-warning": "#ffd27a", "color-border": "#697386",
    },
  },
  {
    id: "paper-blue",
    name: "Paper blue",
    description: "Cool bright neutral",
    scheme: "light",
    tokens: {
      ...DEFAULT_TOKENS,
      "color-bg": "#f4f7fb", "color-surface": "#ffffff", "color-surface-raised": "#e8eef7",
      "color-text": "#172033", "color-text-dimmed": "#526078", "color-primary": "#1d5fbf",
      "color-primary-contrast": "#ffffff", "color-danger": "#b4232f", "color-success": "#176b3a",
      "color-warning": "#7a5100", "color-border": "#cbd5e3",
    },
  },
  {
    id: "warm-paper",
    name: "Warm paper",
    description: "Soft cream and brown",
    scheme: "light",
    tokens: {
      ...DEFAULT_TOKENS,
      "color-bg": "#f8f4ec", "color-surface": "#fffdf8", "color-surface-raised": "#eee6d8",
      "color-text": "#2b241b", "color-text-dimmed": "#655a4a", "color-primary": "#8a4f08",
      "color-primary-contrast": "#ffffff", "color-danger": "#a82932", "color-success": "#28653d",
      "color-warning": "#785000", "color-border": "#d5c8b5",
    },
  },
  {
    id: "sage-light",
    name: "Sage light",
    description: "Quiet green light",
    scheme: "light",
    tokens: {
      ...DEFAULT_TOKENS,
      "color-bg": "#f2f7f3", "color-surface": "#ffffff", "color-surface-raised": "#e2eee6",
      "color-text": "#173023", "color-text-dimmed": "#526a5d", "color-primary": "#17663e",
      "color-primary-contrast": "#ffffff", "color-danger": "#ad2831", "color-success": "#17663e",
      "color-warning": "#765000", "color-border": "#c6d8cc",
    },
  },
  {
    id: "high-contrast-light",
    name: "High contrast light",
    description: "Maximum bright clarity",
    scheme: "light",
    tokens: {
      ...DEFAULT_TOKENS,
      "color-bg": "#ffffff", "color-surface": "#f5f6f8", "color-surface-raised": "#e7e9ee",
      "color-text": "#08090c", "color-text-dimmed": "#3e4652", "color-primary": "#004bc4",
      "color-primary-contrast": "#ffffff", "color-danger": "#a51620", "color-success": "#0c6334",
      "color-warning": "#6b4800", "color-border": "#697386",
    },
  },
];

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

function rgbFromHex(value: string): readonly [number, number, number] | null {
  const match = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return null;
  const number = Number.parseInt(match[1]!, 16);
  return [(number >> 16) & 255, (number >> 8) & 255, number & 255];
}

function relativeLuminance(value: string): number | null {
  const rgb = rgbFromHex(value);
  if (!rgb) return null;
  const [red, green, blue] = rgb.map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return (0.2126 * red!) + (0.7152 * green!) + (0.0722 * blue!);
}

export function contrastRatio(first: string, second: string): number | null {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  if (firstLuminance === null || secondLuminance === null) return null;
  const lighter = Math.max(firstLuminance, secondLuminance);
  const darker = Math.min(firstLuminance, secondLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Pick readable button text when a basic user changes the Accent colour. */
export function readableTextOn(background: string): "#ffffff" | "#10121a" {
  const light = contrastRatio(background, "#ffffff") ?? 0;
  const dark = contrastRatio(background, "#10121a") ?? 0;
  return light >= dark ? "#ffffff" : "#10121a";
}

/** Validate the colour pairs used for normal-size text in the product shell. */
export function validateThemeContrast(tokens: TokenMap): string[] {
  const palette = { ...DEFAULT_TOKENS, ...tokens };
  const checks = [
    ["Text", "color-text", "page background", "color-bg"],
    ["Text", "color-text", "panels", "color-surface"],
    ["Text", "color-text", "raised panels", "color-surface-raised"],
    ["Secondary text", "color-text-dimmed", "page background", "color-bg"],
    ["Accent links", "color-primary", "page background", "color-bg"],
    ["Accent links", "color-primary", "panels", "color-surface"],
    ["Button text", "color-primary-contrast", "Accent", "color-primary"],
  ] as const;
  const errors: string[] = [];
  for (const [foregroundLabel, foregroundKey, backgroundLabel, backgroundKey] of checks) {
    const foreground = palette[foregroundKey]!;
    const background = palette[backgroundKey]!;
    const ratio = contrastRatio(foreground, background);
    if (ratio === null) {
      errors.push(`${foregroundLabel} and ${backgroundLabel} must use six-digit hex colours.`);
    } else if (ratio < 4.5) {
      errors.push(
        `${foregroundLabel} needs more contrast against ${backgroundLabel} (${ratio.toFixed(1)}:1). Use 4.5:1 or higher.`,
      );
    }
  }
  return errors;
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
  style.setProperty("--mantine-color-body", "var(--tantalar-color-bg)");
  style.setProperty("--mantine-color-text", "var(--tantalar-color-text)");
  style.setProperty("--mantine-color-dimmed", "var(--tantalar-color-text-dimmed)");
  style.setProperty("--mantine-color-default", "var(--tantalar-color-surface-raised)");
  style.setProperty(
    "--mantine-color-default-hover",
    "color-mix(in srgb, var(--tantalar-color-surface-raised) 86%, var(--tantalar-color-text))",
  );
  style.setProperty("--mantine-color-default-border", "var(--tantalar-color-border)");
  style.setProperty("--mantine-color-placeholder", "var(--tantalar-color-text-dimmed)");
  style.setProperty("--mantine-primary-color-filled", "var(--tantalar-color-primary)");
  style.setProperty("--mantine-primary-color-contrast", "var(--tantalar-color-primary-contrast)");
  style.setProperty(
    "--mantine-primary-color-filled-hover",
    "color-mix(in srgb, var(--tantalar-color-primary) 86%, var(--tantalar-color-text))",
  );
}
