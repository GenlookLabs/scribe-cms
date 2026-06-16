import { documentLastModified, resolveCanonicalPathname } from "../core/builtin-fields.js";
import type { AllDocuments, ContentTypeConfig, ScribeConfig, ScribeDocument, ScribeProject } from "../core/types.js";
import { getRedirectSourceSlugs } from "../redirects/build-redirects.js";
import { isRoutableType } from "../i18n/build-url.js";
import { joinBaseUrl } from "./join-base-url.js";
import type { GenerateSitemapOptions, SitemapEntry } from "./types.js";

function shouldIncludeEnDoc(
  enDoc: ScribeDocument,
  enSlug: string,
  redirectSources: ReturnType<typeof getRedirectSourceSlugs>,
  contentTypeId: string,
  excludeNoindex: boolean,
): boolean {
  if (redirectSources.aliasSlugs.has(enSlug)) return false;
  const outbound = redirectSources.outboundByType.get(contentTypeId);
  if (outbound?.has(enSlug)) return false;
  if (excludeNoindex && enDoc.noindex) return false;
  return true;
}

type ResolvedSitemapOptions = GenerateSitemapOptions & {
  resolveUrl: (locale: string, pathname: string) => string | Promise<string>;
};

function resolveSitemapOptions(options: GenerateSitemapOptions): ResolvedSitemapOptions {
  return {
    ...options,
    resolveUrl:
      options.resolveUrl ??
      ((_locale, pathname) => joinBaseUrl(options.baseUrl, pathname)),
  };
}

async function buildClusterEntry(
  type: ContentTypeConfig,
  enSlug: string,
  enDoc: ScribeDocument,
  allDocs: AllDocuments,
  config: ScribeConfig,
  options: ResolvedSitemapOptions,
): Promise<SitemapEntry | null> {
  const { defaultLocale, locales } = config;
  const excludeNoindex = options.excludeNoindex !== false;
  const includeXDefault = options.includeXDefault !== false;
  const typeDefaults = options.typeDefaults?.[type.id];

  const pathnameFor = (doc: ScribeDocument): string =>
    options.resolvePathname?.(type, doc, defaultLocale) ??
    resolveCanonicalPathname(type, doc, defaultLocale);

  const alternates: Record<string, string> = {};

  for (const locale of locales) {
    const idx = allDocs.get(locale);
    if (!idx) continue;

    const doc =
      locale === defaultLocale
        ? idx.bySlug.get(enSlug)
        : idx.byEnSlug.get(enSlug);

    if (!doc) continue;
    if (excludeNoindex && doc.noindex) continue;

    const pathname = pathnameFor(doc);
    alternates[locale] = await options.resolveUrl(locale, pathname);
  }

  if (Object.keys(alternates).length === 0) return null;

  const mainUrl =
    alternates[defaultLocale] ?? alternates[Object.keys(alternates)[0]!]!;

  if (includeXDefault && alternates[defaultLocale]) {
    alternates["x-default"] = alternates[defaultLocale];
  }

  const lastModified = documentLastModified(enDoc);

  return {
    url: mainUrl,
    ...(lastModified ? { lastModified } : {}),
    ...(typeDefaults?.changeFrequency
      ? { changeFrequency: typeDefaults.changeFrequency }
      : {}),
    ...(typeDefaults?.priority !== undefined ? { priority: typeDefaults.priority } : {}),
    alternates: { languages: alternates },
  };
}

/** Build sitemap entries with hreflang alternates for routable content types. */
export async function generateSitemap(
  project: ScribeProject,
  options: GenerateSitemapOptions,
): Promise<SitemapEntry[]> {
  const resolvedOptions = resolveSitemapOptions(options);
  const { config } = project;
  const redirectSources = getRedirectSourceSlugs(project);
  const excludeNoindex = options.excludeNoindex !== false;

  const typeIds =
    options.contentTypes ??
    config.types.filter(isRoutableType).map((t) => t.id);

  const entries: SitemapEntry[] = [];

  for (const typeId of typeIds) {
    const runtime = project.getType(typeId);
    const type = runtime.config;
    if (!isRoutableType(type)) continue;

    const allDocs = runtime.load();
    const enIndex = allDocs.get(config.defaultLocale);
    if (!enIndex) continue;

    const processed = new Set<string>();

    for (const [enSlug, enDoc] of enIndex.bySlug) {
      if (processed.has(enSlug)) continue;
      processed.add(enSlug);

      if (
        !shouldIncludeEnDoc(enDoc, enSlug, redirectSources, typeId, excludeNoindex)
      ) {
        continue;
      }

      const entry = await buildClusterEntry(
        type,
        enSlug,
        enDoc,
        allDocs,
        config,
        resolvedOptions,
      );
      if (entry) entries.push(entry);
    }
  }

  return entries;
}
