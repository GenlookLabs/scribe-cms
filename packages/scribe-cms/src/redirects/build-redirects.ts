import type { ScribeProject } from "../core/types.js";
import { listEnSlugs } from "../core/alias-helpers.js";
import { createUrlBuilder, isRoutableType } from "../i18n/build-url.js";
import { buildTranslationIndex } from "../i18n/translation-index.js";
import { openStore } from "../storage/sqlite.js";
import { listTranslationsForEnSlug } from "../storage/translations.js";
import {
  buildJsonRedirects,
  buildLegacyNoBlogPathRedirects,
  buildRedirectSourceSlugSet,
} from "./build-json-redirects.js";
import {
  collectOutboundRedirectSourcesByType,
  collectRedirectSourceSlugs,
  loadAllTypeRedirects,
} from "./load-type-redirects.js";
import type { NextRedirectRule } from "./types.js";

export interface BuildRedirectsOptions {
  /** Locales that use a URL prefix (excludes default locale). Deprecated: derived from localeRouting when omitted. */
  prefixedLocales?: string[];
}

function buildRedirectTranslationIndex(
  project: ScribeProject,
  typeId: string,
  redirectSourceSlugs: Set<string>,
): Map<string, Map<string, string>> {
  const runtime = project.getType(typeId);
  const { config } = project;
  const merged = buildTranslationIndex(
    runtime.load(),
    config.locales,
    config.defaultLocale,
  );

  const db = openStore(project.config, "readonly");
  try {
    for (const alias of redirectSourceSlugs) {
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

function buildCrossLocaleSlugRedirects(
  project: ScribeProject,
  typeId: string,
  redirectSourceSlugs: Set<string>,
): NextRedirectRule[] {
  const type = project.getType(typeId).config;
  if (!isRoutableType(type)) return [];

  const urlBuilder = createUrlBuilder(project.config);
  const translationIndex = buildRedirectTranslationIndex(project, typeId, redirectSourceSlugs);
  const out: NextRedirectRule[] = [];
  const pathTemplate = type.path!;

  for (const [locale, localeMap] of translationIndex) {
    for (const [enSlug, translatedSlug] of localeMap) {
      if (enSlug === translatedSlug) continue;
      if (redirectSourceSlugs.has(enSlug)) continue;
      out.push({
        source: urlBuilder.resolvePath(pathTemplate, enSlug, locale),
        destination: urlBuilder.resolvePath(pathTemplate, translatedSlug, locale),
        permanent: true,
      });
    }
  }

  return out;
}

function buildTypeRedirects(project: ScribeProject, typeId: string): NextRedirectRule[] {
  const loaded = loadAllTypeRedirects(project.config).find((file) => file.contentTypeId === typeId);
  const redirectSourceSlugs = new Set<string>();
  if (loaded) {
    for (const entry of loaded.entries) {
      for (const from of entry.fromSlugs) {
        redirectSourceSlugs.add(from);
      }
    }
  }

  return [
    ...buildCrossLocaleSlugRedirects(project, typeId, redirectSourceSlugs),
  ];
}

/** Build Next.js redirect rules from `_redirects.json`, locale slug fixes, and legacy blog paths. */
export function buildAllContentRedirects(
  project: ScribeProject,
  _options: BuildRedirectsOptions = {},
): NextRedirectRule[] {
  const redirectSourceKeys = buildRedirectSourceSlugSet(project);
  const out: NextRedirectRule[] = [
    ...buildJsonRedirects(project),
    ...buildLegacyNoBlogPathRedirects(project, redirectSourceKeys),
  ];

  for (const type of project.config.types) {
    if (!isRoutableType(type)) continue;
    out.push(...buildTypeRedirects(project, type.id));
  }

  return out;
}

export interface RedirectSourceSlugs {
  /** All inbound redirect source slugs — exclude from sitemap. */
  aliasSlugs: Set<string>;
  /** EN canonical slugs with outbound redirects — exclude from sitemap. */
  outboundByType: Map<string, Set<string>>;
}

/** Slugs excluded from sitemap (redirect sources). */
export function getRedirectSourceSlugs(project: ScribeProject): RedirectSourceSlugs {
  const loaded = loadAllTypeRedirects(project.config);
  const aliasSlugs = collectRedirectSourceSlugs(loaded);
  const outboundByType = collectOutboundRedirectSourcesByType(loaded);

  for (const type of project.config.types) {
    if (!outboundByType.has(type.id)) {
      outboundByType.set(type.id, new Set());
    }
  }

  return {
    aliasSlugs,
    outboundByType,
  };
}

export { listEnSlugs };
