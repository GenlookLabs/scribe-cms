import type { ContentTypeConfig, ScribeDocument, ResolvedDocument } from "../core/types.js";
import { extractSlugFromResolvedPath, resolvePath } from "./build-url.js";

function findEnDocByAlias<TDoc extends ScribeDocument>(
  slug: string,
  allDocs: ReadonlyMap<string, { bySlug: ReadonlyMap<string, TDoc>; byEnSlug: ReadonlyMap<string, TDoc> }>,
  defaultLocale: string,
): TDoc | null {
  const enIdx = allDocs.get(defaultLocale);
  if (!enIdx) return null;
  for (const doc of enIdx.bySlug.values()) {
    if (doc.aliases.includes(slug)) return doc;
  }
  return null;
}

function enCanonicalDoc<TDoc extends ScribeDocument>(
  doc: TDoc,
  allDocs: ReadonlyMap<string, { bySlug: ReadonlyMap<string, TDoc>; byEnSlug: ReadonlyMap<string, TDoc> }>,
  defaultLocale: string,
): TDoc {
  if (doc.locale === defaultLocale) return doc;
  return (allDocs.get(defaultLocale)?.bySlug.get(doc.enSlug) as TDoc | undefined) ?? doc;
}

function redirectPathForDocument<TDoc extends ScribeDocument>(
  doc: TDoc,
  locale: string,
  defaultLocale: string,
  allDocs: ReadonlyMap<string, { bySlug: ReadonlyMap<string, TDoc>; byEnSlug: ReadonlyMap<string, TDoc> }>,
  type: ContentTypeConfig,
): string | undefined {
  if (!type.path) return undefined;
  const enDoc = enCanonicalDoc(doc, allDocs, defaultLocale);
  if (!enDoc.redirectTo) return undefined;

  const targetEnSlug = extractSlugFromResolvedPath(type.path, enDoc.redirectTo);
  if (!targetEnSlug) return undefined;

  const targetEnDoc = allDocs.get(defaultLocale)?.bySlug.get(targetEnSlug);
  const targetSlug = targetEnDoc
    ? (getSlugForLocale(targetEnDoc, defaultLocale, locale, allDocs, defaultLocale) ?? targetEnSlug)
    : targetEnSlug;

  return resolvePath(type.path, targetSlug, locale, defaultLocale);
}

function withRedirectTo<TDoc extends ScribeDocument>(
  result: ResolvedDocument<TDoc>,
  locale: string,
  defaultLocale: string,
  allDocs: ReadonlyMap<string, { bySlug: ReadonlyMap<string, TDoc>; byEnSlug: ReadonlyMap<string, TDoc> }>,
  type: ContentTypeConfig,
): ResolvedDocument<TDoc> {
  if (result.shouldRedirectTo || !result.document) return result;
  const redirect = redirectPathForDocument(result.document, locale, defaultLocale, allDocs, type);
  if (!redirect) return result;
  return {
    document: null,
    actualLocale: result.actualLocale,
    shouldRedirectTo: redirect,
  };
}

/** Resolve a document by slug and locale (fallback, aliases, redirects). */
export function resolveLocalizedDocument<TDoc extends ScribeDocument>(
  slug: string,
  locale: string,
  defaultLocale: string,
  allDocs: ReadonlyMap<string, { bySlug: ReadonlyMap<string, TDoc>; byEnSlug: ReadonlyMap<string, TDoc> }>,
  type: ContentTypeConfig,
): ResolvedDocument<TDoc> {
  const idx = allDocs.get(locale);
  const direct = idx?.bySlug.get(slug);
  if (direct) {
    return withRedirectTo({ document: direct, actualLocale: locale }, locale, defaultLocale, allDocs, type);
  }

  const aliasDoc = findEnDocByAlias(slug, allDocs, defaultLocale);
  if (aliasDoc && type.path) {
    const canonicalSlug = aliasDoc.slug;
    const localizedSlug = getSlugForLocale(aliasDoc, defaultLocale, locale, allDocs, defaultLocale);
    const targetSlug = localizedSlug ?? canonicalSlug;
    if (targetSlug !== slug) {
      return {
        document: null,
        actualLocale: locale,
        shouldRedirectTo: resolvePath(type.path, targetSlug, locale, defaultLocale),
      };
    }
  }

  for (const [docLocale, docIdx] of allDocs) {
    const found = docIdx.bySlug.get(slug);
    if (!found) continue;

    const correctSlug = getSlugForLocale(found, docLocale, locale, allDocs, defaultLocale);
    if (correctSlug && correctSlug !== slug) {
      if (!type.path) {
        return { document: null, actualLocale: locale };
      }
      return {
        document: null,
        actualLocale: locale,
        shouldRedirectTo: resolvePath(type.path, correctSlug, locale, defaultLocale),
      };
    }

    if (docLocale === defaultLocale) {
      return withRedirectTo(
        { document: found as TDoc, actualLocale: defaultLocale },
        locale,
        defaultLocale,
        allDocs,
        type,
      );
    }

    if (!type.path) {
      return { document: null, actualLocale: locale };
    }
    return {
      document: null,
      actualLocale: locale,
      shouldRedirectTo: resolvePath(type.path, found.enSlug, locale, defaultLocale),
    };
  }

  if (locale !== defaultLocale) {
    const enDoc = allDocs.get(defaultLocale)?.bySlug.get(slug);
    if (enDoc && type.indexFallback === "en") {
      return withRedirectTo(
        { document: enDoc as TDoc, actualLocale: defaultLocale },
        locale,
        defaultLocale,
        allDocs,
        type,
      );
    }
    const byEn = idx?.byEnSlug.get(slug);
    if (byEn) {
      return withRedirectTo(
        { document: byEn as TDoc, actualLocale: locale },
        locale,
        defaultLocale,
        allDocs,
        type,
      );
    }
    const fallback = allDocs.get(defaultLocale)?.bySlug.get(slug);
    if (fallback && type.indexFallback === "en") {
      return withRedirectTo(
        { document: fallback as TDoc, actualLocale: defaultLocale },
        locale,
        defaultLocale,
        allDocs,
        type,
      );
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
