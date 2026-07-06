import type { ContentTypeConfig, ScribeDocument, ResolvedDocument } from "../core/types.js";
import { createUrlBuilder } from "./build-url.js";
import type { LocaleRoutingConfig } from "../core/types.js";

/** Resolve a document by slug and locale (fallback, cross-locale slug correction). */
export function resolveLocalizedDocument<TDoc extends ScribeDocument>(
  slug: string,
  locale: string,
  defaultLocale: string,
  allDocs: ReadonlyMap<string, { bySlug: ReadonlyMap<string, TDoc>; byEnSlug: ReadonlyMap<string, TDoc> }>,
  type: ContentTypeConfig,
  localeRouting?: LocaleRoutingConfig,
  fallbackLocales: readonly string[] = [],
): ResolvedDocument<TDoc> {
  const urlBuilder = createUrlBuilder({
    locales: [defaultLocale, locale],
    defaultLocale,
    localeRouting: localeRouting ?? { strategy: "path-prefix", prefixDefaultLocale: false },
  });

  const idx = allDocs.get(locale);
  const direct = idx?.bySlug.get(slug);
  if (direct) {
    return { document: direct, actualLocale: locale };
  }

  for (const [docLocale, docIdx] of allDocs) {
    const found = docIdx.bySlug.get(slug);
    if (!found) continue;

    const enSlug = docLocale === defaultLocale ? found.slug : found.enSlug;

    // Which document should canonically serve the requested locale? Try the
    // requested locale first, then its configured fallback chain.
    let target: TDoc | undefined;
    let targetLocale = locale;
    for (const candidateLocale of [locale, ...fallbackLocales]) {
      const cand =
        candidateLocale === defaultLocale
          ? allDocs.get(candidateLocale)?.bySlug.get(enSlug)
          : allDocs.get(candidateLocale)?.byEnSlug.get(enSlug);
      if (cand) {
        target = cand;
        targetLocale = candidateLocale;
        break;
      }
    }

    if (target) {
      if (target.slug === slug) {
        return { document: target, actualLocale: targetLocale };
      }
      if (!type.path) {
        return { document: null, actualLocale: locale };
      }
      return {
        document: null,
        actualLocale: locale,
        shouldRedirectTo: urlBuilder.resolvePath(type.path, target.slug, locale),
      };
    }

    if (docLocale === defaultLocale) {
      return { document: found as TDoc, actualLocale: defaultLocale };
    }

    if (!type.path) {
      return { document: null, actualLocale: locale };
    }
    return {
      document: null,
      actualLocale: locale,
      shouldRedirectTo: urlBuilder.resolvePath(type.path, found.enSlug, locale),
    };
  }

  if (locale !== defaultLocale) {
    const enDoc = allDocs.get(defaultLocale)?.bySlug.get(slug);
    if (enDoc && type.indexFallback === "en") {
      return { document: enDoc as TDoc, actualLocale: defaultLocale };
    }
    const byEn = idx?.byEnSlug.get(slug);
    if (byEn) {
      return { document: byEn as TDoc, actualLocale: locale };
    }
    const fallback = allDocs.get(defaultLocale)?.bySlug.get(slug);
    if (fallback && type.indexFallback === "en") {
      return { document: fallback as TDoc, actualLocale: defaultLocale };
    }
  }

  return { document: null, actualLocale: locale };
}

/** Map a document slug from one locale to another via the EN parent slug. */
export function getSlugForLocale<TDoc extends ScribeDocument>(
  document: TDoc,
  sourceLocale: string,
  targetLocale: string,
  allDocs: ReadonlyMap<string, { bySlug: ReadonlyMap<string, TDoc>; byEnSlug: ReadonlyMap<string, TDoc> }>,
  defaultLocale: string,
): string | null {
  if (sourceLocale === targetLocale) return document.slug;

  const englishSlug = sourceLocale === defaultLocale ? document.slug : document.enSlug;
  if (!englishSlug) return null;
  if (targetLocale === defaultLocale) return englishSlug;

  return allDocs.get(targetLocale)?.byEnSlug.get(englishSlug)?.slug ?? null;
}
