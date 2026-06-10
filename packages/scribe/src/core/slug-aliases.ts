import { extractSlugFromResolvedPath } from "../i18n/build-url.js";
import type { ScribeProject } from "./types.js";
import { readEnDocument } from "../loader/create-loader.js";
import { enFileExists, isAliasKnown, listEnSlugs } from "./alias-helpers.js";
import { openStore } from "../storage/sqlite.js";
import { listTranslationsForEnSlug } from "../storage/translations.js";

export interface AliasTarget {
  contentTypeId: string;
  canonicalSlug: string;
  path: string;
}

export interface AliasIndexIssue {
  contentTypeId: string;
  enSlug: string;
  field: string;
  message: string;
  level: "error" | "warning" | "info";
}

export interface GlobalAliasIndex {
  aliasToTarget: Map<string, AliasTarget>;
  allAliasSlugs: Set<string>;
  issues: AliasIndexIssue[];
}

/**
 * Build a global alias → canonical map across every registered content type.
 */
export function buildGlobalAliasIndex(project: ScribeProject): GlobalAliasIndex {
  const { config } = project;
  const aliasToTarget = new Map<string, AliasTarget>();
  const allAliasSlugs = new Set<string>();
  const issues: AliasIndexIssue[] = [];

  const canonicalSlugsByType = new Map<string, Set<string>>();

  for (const type of config.types) {
    const slugs = listEnSlugs(config.rootDir, type.contentDir);
    canonicalSlugsByType.set(type.id, new Set(slugs));
  }

  for (const type of config.types) {
    if (!type.path) continue;
    const canonicalSlugs = canonicalSlugsByType.get(type.id) ?? new Set<string>();

    for (const enSlug of canonicalSlugs) {
      const doc = readEnDocument(config, type, enSlug);
      if (!doc) continue;

      for (const alias of doc.aliases) {
        if (alias === enSlug) {
          issues.push({
            contentTypeId: type.id,
            enSlug,
            field: "aliases",
            message: `Alias "${alias}" must not equal the canonical slug`,
            level: "error",
          });
          continue;
        }

        if (canonicalSlugs.has(alias)) {
          issues.push({
            contentTypeId: type.id,
            enSlug,
            field: "aliases",
            message: `Alias "${alias}" collides with another document's canonical slug`,
            level: "error",
          });
          continue;
        }

        const existing = aliasToTarget.get(alias);
        if (existing) {
          issues.push({
            contentTypeId: type.id,
            enSlug,
            field: "aliases",
            message: `Alias "${alias}" is already claimed by ${existing.contentTypeId}/${existing.canonicalSlug}`,
            level: "error",
          });
          continue;
        }

        aliasToTarget.set(alias, {
          contentTypeId: type.id,
          canonicalSlug: enSlug,
          path: type.path!,
        });
        allAliasSlugs.add(alias);
      }
    }
  }

  return { aliasToTarget, allAliasSlugs, issues };
}

/** Warnings and info for registered aliases (unknown, orphan EN files, sqlite history, locale gaps). */
export function validateAliasCoverage(project: ScribeProject): AliasIndexIssue[] {
  const { config } = project;
  const { aliasToTarget } = buildGlobalAliasIndex(project);
  const issues: AliasIndexIssue[] = [];
  const db = openStore(config, "readonly");

  try {
    for (const [alias, target] of aliasToTarget) {
      const type = config.types.find((t) => t.id === target.contentTypeId);
      if (!type) continue;

      const known = isAliasKnown(config, type, alias, db);

      if (!known) {
        issues.push({
          contentTypeId: type.id,
          enSlug: target.canonicalSlug,
          field: "aliases",
          message: `Alias "${alias}" is unknown (no EN file or sqlite translations) — only EN redirect will work`,
          level: "warning",
        });
      }

      if (enFileExists(config, type, alias)) {
        issues.push({
          contentTypeId: type.id,
          enSlug: target.canonicalSlug,
          field: "aliases",
          message: `Alias "${alias}" still has an EN file on disk — delete it manually`,
          level: "warning",
        });
      }

      const sqliteRows = listTranslationsForEnSlug(db, type.id, alias);
      if (sqliteRows.length > 0) {
        issues.push({
          contentTypeId: type.id,
          enSlug: target.canonicalSlug,
          field: "aliases",
          message: `${sqliteRows.length} sqlite translation(s) for alias "${alias}" retained for locale redirects and history`,
          level: "info",
        });
      }

      for (const locale of config.locales) {
        if (locale === config.defaultLocale) continue;

        const canonicalRow = listTranslationsForEnSlug(db, type.id, target.canonicalSlug).find(
          (r) => r.locale === locale,
        );
        if (!canonicalRow) continue;

        const aliasRow = sqliteRows.find((r) => r.locale === locale);

        if (!aliasRow && known) {
          issues.push({
            contentTypeId: type.id,
            enSlug: target.canonicalSlug,
            field: "aliases",
            message: `Alias "${alias}" has no locale slug mapping for ${locale} — old localized URL may miss redirect`,
            level: "warning",
          });
        }
      }
    }
  } finally {
    db.close();
  }

  return issues;
}

/** Detect redirect chains involving aliases or redirect_to. */
export function validateAliasRedirectChains(project: ScribeProject): AliasIndexIssue[] {
  const { config } = project;
  const { aliasToTarget, allAliasSlugs } = buildGlobalAliasIndex(project);
  const issues: AliasIndexIssue[] = [];

  for (const [alias, target] of aliasToTarget) {
    const doc = readEnDocument(
      config,
      project.getType(target.contentTypeId).config,
      target.canonicalSlug,
    );
    if (doc?.redirectTo) {
      issues.push({
        contentTypeId: target.contentTypeId,
        enSlug: target.canonicalSlug,
        field: "aliases",
        message: `Alias "${alias}" points at "${target.canonicalSlug}" which has redirect_to — resolve to the final canonical slug`,
        level: "error",
      });
    }
  }

  for (const type of config.types) {
    if (!type.path) continue;
    for (const enSlug of listEnSlugs(config.rootDir, type.contentDir)) {
      const doc = readEnDocument(config, type, enSlug);
      if (!doc?.redirectTo) continue;

      const targetSlug = extractSlugFromResolvedPath(type.path, doc.redirectTo);
      if (targetSlug && allAliasSlugs.has(targetSlug)) {
        issues.push({
          contentTypeId: type.id,
          enSlug,
          field: "redirect_to",
          message: `redirect_to target "${targetSlug}" is an alias slug — chain detected`,
          level: "error",
        });
      }

      const targetDoc = targetSlug ? readEnDocument(config, type, targetSlug) : null;
      if (targetDoc?.redirectTo) {
        issues.push({
          contentTypeId: type.id,
          enSlug,
          field: "redirect_to",
          message: `redirect_to chain detected: "${enSlug}" → "${targetSlug}" → "${targetDoc.redirectTo}"`,
          level: "error",
        });
      }
    }
  }

  return issues;
}
