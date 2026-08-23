/**
 * Layered YAML configuration per ADR-0010.
 *
 * Order (lowest to highest precedence):
 *   defaults (built-in) -> profile file -> host file -> CLI flag overrides.
 *
 * Rules (locked):
 *  - Later layers override earlier by deep merge; plain lists replace.
 *  - A list key ending in "+" appends instead of replacing.
 *  - Environment variables supply secrets only: TANTALAR_SECRET_*.
 *  - dumpConfig() prints the effective tree with secrets redacted; the dumped
 *    output must be valid as an input layer.
 *  - Unknown keys warn, never silently pass; boot still succeeds.
 */
import { readFileSync } from "node:fs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export interface ConfigWarning {
  readonly layer: string;
  readonly message: string;
}

export interface LoadedConfig {
  readonly config: Record<string, unknown>;
  readonly warnings: readonly ConfigWarning[];
}

type Json = Record<string, unknown>;

export const DEFAULT_CONFIG: Json = {
  server: {
    host: "127.0.0.1",
    port: 8787,
  },
  database: {
    dialect: "sqlite", // "sqlite" | "postgres"
    sqlite: {
      path: "./data/tantalar.db",
    },
    // postgres: { url } supplied via TANTALAR_SECRET_DATABASE_POSTGRES_URL
  },
  logging: {
    level: "info",
  },
  auth: {
    sessionTtlSeconds: 60 * 60 * 24 * 7,
    csrfCookie: "tantalar_csrf",
  },
  plugins: {
    set: {}, // id -> { enabled: true, config: {...} }
    restart: {
      initialBackoffMs: 500,
      maxBackoffMs: 30000,
      backoffMultiplier: 2,
      windowMs: 60_000,
      maxRestartsInWindow: 5,
    },
  },
  scheduler: {
    tickMs: 1000,
  },
};

function isPlainObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep merge; lists replace unless the key ends in "+". */
export function deepMerge<T extends Json>(base: T, override: Json): Json {
  const out: Json = { ...base };
  for (const [rawKey, value] of Object.entries(override)) {
    const append = rawKey.endsWith("+");
    const key = append ? rawKey.slice(0, -1) : rawKey;
    const existing = out[key];
    if (append && Array.isArray(existing) && Array.isArray(value)) {
      out[key] = [...existing, ...value];
    } else if (isPlainObject(existing) && isPlainObject(value)) {
      out[key] = deepMerge(existing, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Collect dotted paths of keys in `obj` not present in the schema tree. */
export function unknownKeys(obj: Json, schema: Json, prefix = ""): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (!(key in schema)) {
      out.push(path);
    } else if (isPlainObject(value) && isPlainObject(schema[key])) {
      out.push(...unknownKeys(value, schema[key] as Json, path));
    }
  }
  return out;
}

/** Recursively redact any key matching the secret patterns. */
const SECRET_KEY_RE = /secret|password|token|apiKey|api_key/i;

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (isPlainObject(value)) {
    const out: Json = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY_RE.test(k) ? "[REDACTED]" : redact(v);
    }
    return out;
  }
  return value;
}

function readLayer(file: string, layer: string, warnings: ConfigWarning[]): Json {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    warnings.push({ layer, message: `cannot read ${file}: ${(err as Error).message}` });
    return {};
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (err) {
    warnings.push({ layer, message: `invalid YAML in ${file}: ${(err as Error).message}` });
    return {};
  }
  if (parsed === undefined || parsed === null) return {};
  if (!isPlainObject(parsed)) {
    warnings.push({ layer, message: `${file}: top level must be a mapping` });
    return {};
  }
  return parsed;
}

function applyEnvSecrets(config: Json, env: NodeJS.ProcessEnv): void {
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith("TANTALAR_SECRET_") || value === undefined) continue;
    // TANTALAR_SECRET_DATABASE__POSTGRES__URL -> database.postgres.url
    const segments = name
      .slice("TANTALAR_SECRET_".length)
      .split("__")
      .map((seg) => seg.toLowerCase());
    let cursor: Json = config;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i] as string;
      if (!isPlainObject(cursor[seg])) cursor[seg] = {};
      cursor = cursor[seg] as Json;
    }
    // Store { value, secret: true } so dumps redact even non-secret key names.
    cursor[segments[segments.length - 1] as string] = { value, secret: true };
  }
}

export interface LoadOptions {
  readonly profileFile?: string;
  readonly hostFile?: string;
  readonly cliOverrides?: Json;
  readonly env?: NodeJS.ProcessEnv;
}

export function loadConfig(options: LoadOptions = {}): LoadedConfig {
  const warnings: ConfigWarning[] = [];
  let config = structuredClone(DEFAULT_CONFIG);

  const layers: Array<[string, string | undefined]> = [
    ["profile", options.profileFile],
    ["host", options.hostFile],
  ];
  for (const [layer, file] of layers) {
    if (!file) continue;
    const parsed = readLayer(file, layer, warnings);
    for (const key of unknownKeys(parsed, config)) {
      warnings.push({ layer, message: `unknown config key: ${key}` });
    }
    config = deepMerge(config, parsed);
  }

  if (options.cliOverrides) {
    for (const key of unknownKeys(options.cliOverrides, config)) {
      warnings.push({ layer: "cli", message: `unknown config key: ${key}` });
    }
    config = deepMerge(config, options.cliOverrides);
  }

  applyEnvSecrets(config, options.env ?? process.env);

  return { config, warnings };
}

/** Effective config as YAML with secrets redacted; valid as an input layer. */
export function dumpConfig(config: Json): string {
  // Mask env-secret wrappers ({value, secret:true}) BEFORE unwrapping: after
  // unsecret() the marker is gone and the value would leak into the dump.
  const masked = redact(maskSecretValues(config)) as Json;
  return stringifyYaml(unsecret(masked)).trimEnd() + "\n";
}

/** Replace secret-wrapper values with [REDACTED]. */
function maskSecretValues(config: Json): Json {
  const out: Json = {};
  for (const [key, value] of Object.entries(config)) {
    if (isPlainObject(value) && value["secret"] === true && "value" in value) {
      out[key] = "[REDACTED]";
    } else if (isPlainObject(value)) {
      out[key] = maskSecretValues(value);
    } else {
      out[key] = value as Json;
    }
  }
  return out;
}

/**
 * Env-supplied secrets are stored as { value, secret: true } wrappers.
 * unsecret() resolves them for runtime use; dumpConfig replaces them with
 * [REDACTED] so the plaintext never reaches the dumped layer.
 */
export function unsecret(config: Json): Json {
  const out: Json = {};
  for (const [key, value] of Object.entries(config)) {
    if (isPlainObject(value) && value["secret"] === true && "value" in value) {
      out[key] = value["value"];
    } else if (isPlainObject(value)) {
      out[key] = unsecret(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Parse a dumped (redacted) config back — proves round-trip validity. */
export function parseConfigYaml(text: string): Json {
  const parsed = parseYaml(text);
  if (!isPlainObject(parsed)) throw new Error("config text must be a mapping");
  return parsed;
}
