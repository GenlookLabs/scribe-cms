import path from "node:path";
import type {
  ContentTypeConfig,
  LocaleFallbacks,
  ResolvedAssetsConfig,
  ScribeConfig,
  ScribeConfigInput,
} from "../core/types.js";
import { assertValidPathTemplate } from "../i18n/build-url.js";

const RESOLVED = Symbol.for("@genlook/scribe/resolvedConfig");

/** Whether a config object has already been normalized by `resolveConfig()`. */
export function isResolvedConfig(config: unknown): config is ScribeConfig {
  return (
    typeof config === "object" &&
    config !== null &&
    (config as Record<symbol, unknown>)[RESOLVED] === true
  );
}

/**
 * Normalize a user config: apply defaults, make paths absolute, and validate
 * invariants. Every entry point (`createScribe`, the CLI's `loadConfigSync`)
 * must pass configs through here so runtimes never see partial configs.
 *
 * @param baseDir directory used to resolve a relative `rootDir`
 *   (the config file's directory for the CLI; `process.cwd()` otherwise).
 */
export function resolveConfig(
  input: ScribeConfigInput<any> | ScribeConfig,
  baseDir?: string,
): ScribeConfig {
  if (isResolvedConfig(input)) return input;
  const raw = input as ScribeConfigInput;

  if (!raw.rootDir) {
    throw new Error("scribe config: rootDir is required");
  }
  if (!raw.locales || raw.locales.length === 0) {
    throw new Error("scribe config: locales must be a non-empty array");
  }
  const defaultLocale = raw.defaultLocale ?? "en";
  if (!raw.locales.includes(defaultLocale)) {
    throw new Error(
      `scribe config: defaultLocale "${defaultLocale}" is not in locales [${raw.locales.join(", ")}]`,
    );
  }

  const localeRouting = raw.localeRouting ?? {
    strategy: "path-prefix" as const,
    prefixDefaultLocale: false,
  };
  if (localeRouting.strategy === "search-param" && !localeRouting.param) {
    throw new Error('scribe config: localeRouting search-param requires a "param" name');
  }

  const localeFallbacks =
    raw.localeFallbacks === false
      ? {}
      : deriveLocaleFallbacks(raw.locales, defaultLocale);

  const projectRoot = path.resolve(baseDir ?? process.cwd(), raw.rootDir);
  const contentRoot = path.resolve(projectRoot, raw.contentDir ?? "content");
  const storePath = path.resolve(projectRoot, raw.store ?? ".scribe/store.sqlite");

  // The asset system is opt-in: enabled only when `assets` or the deprecated
  // `assetsDir` is set. When enabled, `assets` wins over `assetsDir`, and dir /
  // publicPath / managedDirs default to "public" / "/" / []. Left off entirely,
  // both `assetsPath` and `assets` stay undefined so no asset validation runs.
  let assetsPath: string | undefined;
  let assets: ResolvedAssetsConfig | undefined;
  if (raw.assets !== undefined || raw.assetsDir !== undefined) {
    const dir = raw.assets?.dir ?? raw.assetsDir ?? "public";
    const publicPath = raw.assets?.publicPath ?? "/";
    const managedDirs = raw.assets?.managedDirs ?? [];
    assetsPath = path.resolve(projectRoot, dir);
    assets = { assetsPath, publicPath, managedDirs };
  }

  const seenIds = new Set<string>();
  const types: ContentTypeConfig[] = raw.types.map((type) => {
    if (seenIds.has(type.id)) {
      throw new Error(`scribe config: duplicate content type id "${type.id}"`);
    }
    seenIds.add(type.id);
    if (type.path) {
      assertValidPathTemplate(type.path, type.id);
    }
    return {
      ...type,
      contentDir: type.contentDir ?? type.id,
      label: type.label ?? type.id.charAt(0).toUpperCase() + type.id.slice(1),
      slugStrategy: type.slugStrategy ?? "fixed",
      indexFallback: type.indexFallback ?? (type.path ? "en" : "none"),
      // `body` defaults to true (fully backwards compatible). A resolved type
      // always carries an explicit boolean so consumers read one source of truth.
      body: type.body ?? true,
    };
  });

  const config: ScribeConfig = {
    rootDir: contentRoot,
    storePath,
    assetsPath,
    assets,
    locales: [...raw.locales],
    defaultLocale,
    localeRouting,
    localePresets: raw.localePresets,
    localeFallbacks,
    translate: raw.translate,
    types,
  };
  Object.defineProperty(config, RESOLVED, {
    value: true,
    enumerable: false,
  });
  return config;
}

/**
 * Derive fallback chains from locale tags: each locale falls back to its
 * successively shorter tag prefixes (longest first) that are themselves
 * configured, e.g. `"zh-Hant-TW"` → `["zh-Hant", "zh"]`. Prefix matching is
 * case-insensitive (BCP-47 casing varies); chains store the configured
 * spelling. The default locale is excluded — it stays the implicit final
 * fallback so `indexFallback: "none"` keeps its meaning.
 */
function deriveLocaleFallbacks(
  locales: readonly string[],
  defaultLocale: string,
): LocaleFallbacks {
  const byLowercase = new Map(locales.map((l) => [l.toLowerCase(), l]));
  const fallbacks: LocaleFallbacks = {};
  for (const locale of locales) {
    const subtags = locale.split("-");
    if (subtags.length < 2) continue;
    const chain: string[] = [];
    for (let end = subtags.length - 1; end >= 1; end--) {
      const prefix = byLowercase.get(subtags.slice(0, end).join("-").toLowerCase());
      if (prefix && prefix !== locale && prefix !== defaultLocale) {
        chain.push(prefix);
      }
    }
    if (chain.length > 0) {
      fallbacks[locale] = chain;
    }
  }
  return fallbacks;
}
