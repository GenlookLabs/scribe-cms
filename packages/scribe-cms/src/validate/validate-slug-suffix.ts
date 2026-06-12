import type Database from "better-sqlite3";
import { findLocaleSuffixInSlug } from "../core/localized-slug.js";
import type { ScribeConfig } from "../core/types.js";
import { bulkLoadTranslations } from "../storage/translations.js";

export interface SlugSuffixIssue {
  contentTypeId: string;
  enSlug: string;
  locale: string;
  slug: string;
  message: string;
}

/** GEN-241: translated slugs must not end with a locale code suffix. */
export function validateTranslationSlugSuffixes(
  config: ScribeConfig,
  db: Database.Database,
): SlugSuffixIssue[] {
  const issues: SlugSuffixIssue[] = [];
  const localeCodes = config.locales.filter((l) => l !== config.defaultLocale);

  for (const row of bulkLoadTranslations(db)) {
    if (row.locale === config.defaultLocale) continue;

    const matchedCode = findLocaleSuffixInSlug(row.slug, localeCodes);
    if (matchedCode) {
      issues.push({
        contentTypeId: row.content_type,
        enSlug: row.en_slug,
        locale: row.locale,
        slug: row.slug,
        message: `Translation slug "${row.slug}" ends with locale code "-${matchedCode}"`,
      });
    }
  }

  return issues;
}
