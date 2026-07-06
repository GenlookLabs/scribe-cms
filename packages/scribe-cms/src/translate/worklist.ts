import fs from "node:fs";
import path from "node:path";
import type { ScribeConfig } from "../core/types.js";
import { isPublishableContentFile } from "../loader/normalize-en.js";
import { computePageEnHash } from "../hash/page-hash.js";
import { getTranslatablePayload, readEnDocument } from "../loader/create-loader.js";
import { openStore } from "../storage/sqlite.js";
import { getTranslation } from "../storage/translations.js";

export interface TranslationWorkItem {
  contentType: string;
  enSlug: string;
  locale: string;
  reason: "missing" | "stale" | "forced";
  currentEnHash: string;
  storedEnHash?: string;
  /**
   * Verbatim validation error from a prior attempt in the same run. Set only for
   * the one-shot retry round; appended to the prompt's locale-specific suffix so
   * the model can correct the exact issues.
   */
  previousError?: string;
}

export type TranslationWorklistStrategy = "all" | "missing-only";

export interface WorklistOptions {
  /** Single id or comma-separated ids (e.g. `vertical,platform`). */
  contentType?: string;
  locales?: string[];
  enSlug?: string;
  /** Which pages to include: all stale/missing (default) or missing only. */
  strategy?: TranslationWorklistStrategy;
  /** Include fresh translations so prepareTranslation re-runs despite matching hashes. */
  force?: boolean;
}

function parseContentTypeFilter(contentType?: string): Set<string> | undefined {
  if (!contentType) return undefined;
  const ids = contentType
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  return ids.length > 0 ? new Set(ids) : undefined;
}

function listEnSlugs(rootDir: string, contentDir: string): string[] {
  const dir = path.join(rootDir, contentDir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter(isPublishableContentFile)
    .map((f) => f.replace(/\.(md|mdx)$/, ""));
}

/** List locale pages that are missing or stale vs current EN content. */
export function buildWorklist(config: ScribeConfig, options: WorklistOptions = {}): TranslationWorkItem[] {
  const db = openStore(config, "readonly");
  const items: TranslationWorkItem[] = [];
  const locales =
    options.locales ??
    config.locales.filter((locale) => locale !== config.defaultLocale);
  const contentTypes = parseContentTypeFilter(options.contentType);

  for (const type of config.types) {
    if (contentTypes && !contentTypes.has(type.id)) continue;
    const enSlugs = options.enSlug ? [options.enSlug] : listEnSlugs(config.rootDir, type.contentDir);

    for (const enSlug of enSlugs) {
      const enDoc = readEnDocument(config, type, enSlug);
      if (!enDoc) continue;
      const payload = getTranslatablePayload(enDoc, type);
      const currentEnHash = computePageEnHash(payload.frontmatter, payload.body);

      for (const locale of locales) {
        if (locale === config.defaultLocale) continue;
        const existing = getTranslation(db, type.id, enSlug, locale);
        if (!existing) {
          items.push({
            contentType: type.id,
            enSlug,
            locale,
            reason: "missing",
            currentEnHash,
          });
          continue;
        }
        const stale = existing.en_hash !== currentEnHash;
        if (stale || options.force) {
          items.push({
            contentType: type.id,
            enSlug,
            locale,
            reason: stale ? "stale" : "forced",
            currentEnHash,
            storedEnHash: existing.en_hash,
          });
        }
      }
    }
  }

  db.close();
  const strategy = options.strategy ?? "all";
  if (strategy === "missing-only") {
    return items.filter((item) => item.reason === "missing");
  }
  return items;
}

/** Resolve target locales from CLI flags or a named preset. */
export function resolveLocalesFromPreset(
  config: ScribeConfig,
  preset?: string,
  explicitLocales?: string[],
): string[] {
  if (explicitLocales?.length) return explicitLocales;
  if (preset && config.localePresets?.[preset]) {
    return config.localePresets[preset]!.filter((l) => l !== config.defaultLocale);
  }
  return config.locales.filter((l) => l !== config.defaultLocale);
}
