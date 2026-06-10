import type { ContentTypeConfig, ScribeProject } from "../core/types.js";
import { buildGlobalAliasIndex } from "../core/slug-aliases.js";
import { listEnSlugs } from "../core/alias-helpers.js";
import { readEnDocument } from "../loader/create-loader.js";
import { buildRedirectTranslationIndex } from "./translation-index.js";
import type { NextRedirectRule } from "./types.js";
import { extractSlugFromResolvedPath, isRoutableType, resolvePath } from "../i18n/build-url.js";

export interface BuildRedirectsOptions {
  /** Locales that use a URL prefix (excludes default locale). */
  prefixedLocales: string[];
}

function buildAliasRedirects(
  type: ContentTypeConfig,
  aliasIndex: ReturnType<typeof buildGlobalAliasIndex>,
  translationIndex: Map<string, Map<string, string>>,
  prefixedLocales: string[],
  defaultLocale: string,
): NextRedirectRule[] {
  const out: NextRedirectRule[] = [];
  const { aliasToTarget } = aliasIndex;
  const pathTemplate = type.path!;

  for (const [alias, target] of aliasToTarget) {
    if (target.contentTypeId !== type.id) continue;

    const canonical = target.canonicalSlug;

    out.push({
      source: resolvePath(pathTemplate, alias, defaultLocale, defaultLocale),
      destination: resolvePath(pathTemplate, canonical, defaultLocale, defaultLocale),
      permanent: true,
    });

    for (const locale of prefixedLocales) {
      const localeMap = translationIndex.get(locale);
      const toLocale = localeMap?.get(canonical) ?? canonical;
      const fromLocale = localeMap?.get(alias);

      if (fromLocale) {
        out.push({
          source: resolvePath(pathTemplate, fromLocale, locale, defaultLocale),
          destination: resolvePath(pathTemplate, toLocale, locale, defaultLocale),
          permanent: true,
        });
      }

      out.push({
        source: resolvePath(pathTemplate, alias, locale, defaultLocale),
        destination: resolvePath(pathTemplate, toLocale, locale, defaultLocale),
        permanent: true,
      });
    }
  }

  return out;
}

function buildAliasLegacyNoBlogPathRedirects(
  type: ContentTypeConfig,
  aliasIndex: ReturnType<typeof buildGlobalAliasIndex>,
  translationIndex: Map<string, Map<string, string>>,
  prefixedLocales: string[],
  defaultLocale: string,
): NextRedirectRule[] {
  if (type.id !== "blog") return [];

  const out: NextRedirectRule[] = [];

  for (const [alias, target] of aliasIndex.aliasToTarget) {
    if (target.contentTypeId !== type.id) continue;

    for (const locale of prefixedLocales) {
      const localeMap = translationIndex.get(locale);
      const toLocale = localeMap?.get(target.canonicalSlug) ?? target.canonicalSlug;
      out.push({
        source: `/${locale}/${alias}`,
        destination: resolvePath(type.path!, toLocale, locale, defaultLocale),
        permanent: true,
      });
    }
  }

  return out;
}

function buildRedirectToRules(
  type: ContentTypeConfig,
  config: ScribeProject["config"],
  translationIndex: Map<string, Map<string, string>>,
  prefixedLocales: string[],
  defaultLocale: string,
): NextRedirectRule[] {
  const out: NextRedirectRule[] = [];
  const pathTemplate = type.path!;

  for (const enSlug of listEnSlugs(config.rootDir, type.contentDir)) {
    const doc = readEnDocument(config, type, enSlug);
    if (!doc?.redirectTo) continue;

    out.push({
      source: resolvePath(pathTemplate, enSlug, defaultLocale, defaultLocale),
      destination: doc.redirectTo,
      permanent: true,
    });

    for (const locale of prefixedLocales) {
      const localeMap = translationIndex.get(locale);
      const fromLocale = localeMap?.get(enSlug);
      if (!fromLocale) continue;

      const targetEnSlug = extractSlugFromResolvedPath(pathTemplate, doc.redirectTo);
      if (!targetEnSlug) continue;
      const toLocale = localeMap?.get(targetEnSlug) ?? targetEnSlug;
      out.push({
        source: resolvePath(pathTemplate, fromLocale, locale, defaultLocale),
        destination: resolvePath(pathTemplate, toLocale, locale, defaultLocale),
        permanent: true,
      });
    }
  }

  return out;
}

function buildCrossLocaleSlugRedirects(
  type: ContentTypeConfig,
  translationIndex: Map<string, Map<string, string>>,
  aliasSourceSlugs: Set<string>,
  defaultLocale: string,
): NextRedirectRule[] {
  const out: NextRedirectRule[] = [];
  const pathTemplate = type.path!;

  for (const [locale, localeMap] of translationIndex) {
    for (const [enSlug, translatedSlug] of localeMap) {
      if (enSlug === translatedSlug) continue;
      if (aliasSourceSlugs.has(enSlug)) continue;
      out.push({
        source: resolvePath(pathTemplate, enSlug, locale, defaultLocale),
        destination: resolvePath(pathTemplate, translatedSlug, locale, defaultLocale),
        permanent: true,
      });
    }
  }

  return out;
}

/** Legacy inbound links that omit `/blog/` (blog-only). */
function buildLegacyNoBlogPathRedirects(
  type: ContentTypeConfig,
  config: ScribeProject["config"],
  translationIndex: Map<string, Map<string, string>>,
  prefixedLocales: string[],
  defaultLocale: string,
): NextRedirectRule[] {
  if (type.id !== "blog") return [];

  const out: NextRedirectRule[] = [];
  const enSlugs = listEnSlugs(config.rootDir, type.contentDir);
  const pathTemplate = type.path!;

  for (const enSlug of enSlugs) {
    out.push({
      source: `/${enSlug}`,
      destination: resolvePath(pathTemplate, enSlug, defaultLocale, defaultLocale),
      permanent: true,
    });

    for (const locale of prefixedLocales) {
      const translatedSlug = translationIndex.get(locale)?.get(enSlug);
      const canonicalSlug = translatedSlug ?? enSlug;
      out.push({
        source: `/${locale}/${enSlug}`,
        destination: resolvePath(pathTemplate, canonicalSlug, locale, defaultLocale),
        permanent: true,
      });
    }
  }

  return out;
}

function buildTypeRedirects(
  project: ScribeProject,
  typeId: string,
  aliasIndex: ReturnType<typeof buildGlobalAliasIndex>,
  options: BuildRedirectsOptions,
): NextRedirectRule[] {
  const type = project.getType(typeId).config;
  if (!isRoutableType(type)) return [];

  const { defaultLocale } = project.config;
  const translationIndex = buildRedirectTranslationIndex(project, typeId);
  const aliasSourceSlugs = new Set<string>();
  for (const [alias, target] of aliasIndex.aliasToTarget) {
    if (target.contentTypeId === typeId) aliasSourceSlugs.add(alias);
  }

  return [
    ...buildAliasRedirects(type, aliasIndex, translationIndex, options.prefixedLocales, defaultLocale),
    ...buildAliasLegacyNoBlogPathRedirects(
      type,
      aliasIndex,
      translationIndex,
      options.prefixedLocales,
      defaultLocale,
    ),
    ...buildRedirectToRules(type, project.config, translationIndex, options.prefixedLocales, defaultLocale),
    ...buildCrossLocaleSlugRedirects(type, translationIndex, aliasSourceSlugs, defaultLocale),
    ...buildLegacyNoBlogPathRedirects(type, project.config, translationIndex, options.prefixedLocales, defaultLocale),
  ];
}

/** Build Next.js redirect rules from aliases, redirect_to, and locale slug fixes. */
export function buildAllContentRedirects(
  project: ScribeProject,
  options: BuildRedirectsOptions,
): NextRedirectRule[] {
  const aliasIndex = buildGlobalAliasIndex(project);
  const out: NextRedirectRule[] = [];

  for (const type of project.config.types) {
    if (!isRoutableType(type)) continue;
    out.push(...buildTypeRedirects(project, type.id, aliasIndex, options));
  }

  return out;
}

export interface RedirectSourceSlugs {
  /** All alias slugs (inbound old slugs) — exclude from sitemap. */
  aliasSlugs: Set<string>;
  /** EN canonical slugs with outbound redirect_to — exclude from sitemap. */
  outboundByType: Map<string, Set<string>>;
}

/** Slugs excluded from sitemap (aliases and outbound redirect_to sources). */
export function getRedirectSourceSlugs(project: ScribeProject): RedirectSourceSlugs {
  const aliasIndex = buildGlobalAliasIndex(project);
  const outboundByType = new Map<string, Set<string>>();

  for (const type of project.config.types) {
    const outbound = new Set<string>();
    for (const enSlug of listEnSlugs(project.config.rootDir, type.contentDir)) {
      const doc = readEnDocument(project.config, type, enSlug);
      if (doc?.redirectTo) outbound.add(enSlug);
    }
    outboundByType.set(type.id, outbound);
  }

  return {
    aliasSlugs: aliasIndex.allAliasSlugs,
    outboundByType,
  };
}
