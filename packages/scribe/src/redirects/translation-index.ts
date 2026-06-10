import type { ScribeProject } from "../core/types.js";
import { buildGlobalAliasIndex } from "../core/slug-aliases.js";
import { buildTranslationIndex } from "../i18n/translation-index.js";
import { openStore } from "../storage/sqlite.js";
import { listTranslationsForEnSlug } from "../storage/translations.js";

/** Merged en_slug → locale slug map for redirect expansion (loader + orphan sqlite alias rows). */
export function buildRedirectTranslationIndex(
  project: ScribeProject,
  typeId: string,
): Map<string, Map<string, string>> {
  const runtime = project.getType(typeId);
  const { config } = project;
  const merged = buildTranslationIndex(
    runtime.load(),
    config.locales,
    config.defaultLocale,
  );

  const { aliasToTarget } = buildGlobalAliasIndex(project);
  const db = openStore(project.config, "readonly");

  try {
    for (const [alias, target] of aliasToTarget) {
      if (target.contentTypeId !== typeId) continue;

      for (const row of listTranslationsForEnSlug(db, typeId, alias)) {
        const localeMap = merged.get(row.locale) ?? new Map<string, string>();
        if (!localeMap.has(alias)) {
          localeMap.set(alias, row.slug);
        }
        merged.set(row.locale, localeMap);
      }
    }
  } finally {
    db.close();
  }

  return merged;
}
