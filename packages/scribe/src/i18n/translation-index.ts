import type { AllDocuments } from "../core/types.js";

/**
 * Internal: locale → (en_slug → locale slug) map for all non-default locales.
 * Consumed by `staticParams()`, `alternates()`, and redirect expansion.
 */
export function buildTranslationIndex(
  allDocs: AllDocuments,
  locales: readonly string[],
  defaultLocale: string,
): Map<string, Map<string, string>> {
  const index = new Map<string, Map<string, string>>();
  for (const locale of locales) {
    if (locale === defaultLocale) continue;
    const idx = allDocs.get(locale);
    if (!idx) continue;
    const localeMap = new Map<string, string>();
    for (const [enSlug, doc] of idx.byEnSlug) {
      localeMap.set(enSlug, doc.slug);
    }
    index.set(locale, localeMap);
  }
  return index;
}
