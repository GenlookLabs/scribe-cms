import path from "node:path";
import type {
  ContentTypeConfig,
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

  const projectRoot = path.resolve(baseDir ?? process.cwd(), raw.rootDir);
  const contentRoot = path.resolve(projectRoot, raw.contentDir ?? "content");
  const storePath = path.resolve(projectRoot, raw.store ?? ".scribe/store.sqlite");
  const assetsPath = raw.assetsDir ? path.resolve(projectRoot, raw.assetsDir) : undefined;

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
    };
  });

  const config: ScribeConfig = {
    rootDir: contentRoot,
    storePath,
    assetsPath,
    locales: [...raw.locales],
    defaultLocale,
    localePresets: raw.localePresets,
    translate: raw.translate,
    types,
  };
  Object.defineProperty(config, RESOLVED, {
    value: true,
    enumerable: false,
  });
  return config;
}
