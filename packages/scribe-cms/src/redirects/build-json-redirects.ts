import type Database from "better-sqlite3";
import type { ContentTypeConfig, ScribeProject } from "../core/types.js";
import { listEnSlugs } from "../core/alias-helpers.js";
import { createUrlBuilder, isRoutableType } from "../i18n/build-url.js";
import { openStore } from "../storage/sqlite.js";
import { listTranslationsForEnSlug } from "../storage/translations.js";
import { loadTypeRedirectsFile } from "./load-type-redirects.js";
import type { ParsedRedirectEntry } from "./redirect-schema.js";
import type { NextRedirectRule } from "./types.js";

function localizedSlug(
  db: Database.Database,
  contentTypeId: string,
  enSlug: string,
  locale: string,
  defaultLocale: string,
): string {
  if (locale === defaultLocale) return enSlug;
  const row = listTranslationsForEnSlug(db, contentTypeId, enSlug).find(
    (translation) => translation.locale === locale,
  );
  return row?.slug ?? enSlug;
}

function resolveSlugTargetDestination(
  project: ScribeProject,
  db: Database.Database,
  targetType: ContentTypeConfig,
  toSlug: string,
  locale: string,
  urlBuilder: ReturnType<typeof createUrlBuilder>,
): string {
  const targetSlug = localizedSlug(
    db,
    targetType.id,
    toSlug,
    locale,
    project.config.defaultLocale,
  );
  return urlBuilder.resolvePath(targetType.path!, targetSlug, locale);
}

function buildEntryRules(
  project: ScribeProject,
  sourceType: ContentTypeConfig,
  entry: ParsedRedirectEntry,
  db: Database.Database,
  urlBuilder: ReturnType<typeof createUrlBuilder>,
): NextRedirectRule[] {
  if (!isRoutableType(sourceType)) return [];

  const out: NextRedirectRule[] = [];
  const { defaultLocale } = project.config;

  let targetType: ContentTypeConfig = sourceType;
  if (entry.kind === "cross-type") {
    const resolvedTarget = project.config.types.find((type) => type.id === entry.toType);
    if (!resolvedTarget?.path) return out;
    targetType = resolvedTarget;
  }

  for (const fromEnSlug of entry.fromSlugs) {
    const locales = project.config.locales;
    for (const locale of locales) {
      const fromSlug = localizedSlug(db, sourceType.id, fromEnSlug, locale, defaultLocale);
      const source = urlBuilder.resolvePath(sourceType.path!, fromSlug, locale);

      let destination: string;
      if (entry.kind === "anywhere") {
        destination = entry.toUrl!;
      } else {
        destination = resolveSlugTargetDestination(
          project,
          db,
          entry.kind === "cross-type" ? targetType : sourceType,
          entry.toSlug!,
          locale,
          urlBuilder,
        );
      }

      if (source === destination) continue;

      out.push({
        source,
        destination,
        permanent: entry.permanent,
      });
    }

    if (sourceType.id === "blog") {
      let destinationEn: string;
      if (entry.kind === "anywhere") {
        destinationEn = entry.toUrl!;
      } else {
        destinationEn = resolveSlugTargetDestination(
          project,
          db,
          entry.kind === "cross-type" ? targetType : sourceType,
          entry.toSlug!,
          defaultLocale,
          urlBuilder,
        );
      }

      out.push({
        source: `/${fromEnSlug}`,
        destination: destinationEn,
        permanent: entry.permanent,
      });

      for (const locale of urlBuilder.prefixedLocales) {
        const fromSlug = localizedSlug(db, sourceType.id, fromEnSlug, locale, defaultLocale);
        let destination: string;
        if (entry.kind === "anywhere") {
          destination = entry.toUrl!;
        } else {
          destination = resolveSlugTargetDestination(
            project,
            db,
            entry.kind === "cross-type" ? targetType : sourceType,
            entry.toSlug!,
            locale,
            urlBuilder,
          );
        }

        out.push({
          source: `/${locale}/${fromSlug}`,
          destination,
          permanent: entry.permanent,
        });

        out.push({
          source: `/${locale}/${fromEnSlug}`,
          destination,
          permanent: entry.permanent,
        });
      }
    }
  }

  return out;
}

export function buildJsonRedirects(project: ScribeProject): NextRedirectRule[] {
  const urlBuilder = createUrlBuilder(project.config);
  const db = openStore(project.config, "readonly");
  const out: NextRedirectRule[] = [];

  try {
    for (const type of project.config.types) {
      if (!isRoutableType(type)) continue;
      const loaded = loadTypeRedirectsFile(project.config, type);
      if (!loaded) continue;

      for (const entry of loaded.entries) {
        out.push(...buildEntryRules(project, type, entry, db, urlBuilder));
      }
    }
  } finally {
    db.close();
  }

  return out;
}

export function buildRedirectSourceSlugSet(project: ScribeProject): Set<string> {
  const out = new Set<string>();
  for (const type of project.config.types) {
    const loaded = loadTypeRedirectsFile(project.config, type);
    if (!loaded) continue;
    for (const entry of loaded.entries) {
      for (const from of entry.fromSlugs) {
        out.add(`${type.id}:${from}`);
      }
    }
  }
  return out;
}

export function buildLegacyNoBlogPathRedirects(
  project: ScribeProject,
  redirectSourceKeys: Set<string>,
): NextRedirectRule[] {
  const blogType = project.config.types.find((type) => type.id === "blog" && type.path);
  if (!blogType?.path) return [];

  const urlBuilder = createUrlBuilder(project.config);
  const db = openStore(project.config, "readonly");
  const out: NextRedirectRule[] = [];

  try {
    for (const enSlug of listEnSlugs(project.config.rootDir, blogType.contentDir)) {
      if (redirectSourceKeys.has(`blog:${enSlug}`)) continue;

      out.push({
        source: `/${enSlug}`,
        destination: urlBuilder.resolvePath(blogType.path, enSlug, project.config.defaultLocale),
        permanent: true,
      });

      for (const locale of urlBuilder.prefixedLocales) {
        const translatedSlug = localizedSlug(
          db,
          blogType.id,
          enSlug,
          locale,
          project.config.defaultLocale,
        );
        out.push({
          source: `/${locale}/${enSlug}`,
          destination: urlBuilder.resolvePath(blogType.path, translatedSlug, locale),
          permanent: true,
        });
      }
    }
  } finally {
    db.close();
  }

  return out;
}
