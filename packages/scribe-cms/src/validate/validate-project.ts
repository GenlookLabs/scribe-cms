import fs from "node:fs";
import path from "node:path";
import type { ScribeConfig } from "../core/types.js";
import { createProject } from "../create-project.js";
import {
  buildGlobalAliasIndex,
  validateAliasCoverage,
  validateAliasRedirectChains,
} from "../core/slug-aliases.js";
import { validateLocaleBuiltinFields } from "../core/builtin-fields.js";
import { readEnDocument } from "../loader/create-loader.js";
import { isPublishableContentFile } from "../loader/normalize-en.js";
import { openStore } from "../storage/sqlite.js";
import { isRoutableType } from "../i18n/build-url.js";
import { getTranslation } from "../storage/translations.js";
import { validateRelations } from "./validate-relations.js";
import { validateDocumentAssets } from "./validate-assets.js";
import { validateTranslationSlugSuffixes } from "./validate-slug-suffix.js";

export interface ValidateIssue {
  level: "error" | "warning" | "info";
  contentType?: string;
  enSlug?: string;
  locale?: string;
  field?: string;
  message: string;
}

export interface ValidateResult {
  ok: boolean;
  issues: ValidateIssue[];
}

function listEnSlugs(rootDir: string, contentDir: string): string[] {
  const dir = path.join(rootDir, contentDir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter(isPublishableContentFile)
    .map((f) => f.replace(/\.(md|mdx)$/, ""));
}

/** Validate EN files, SQLite consistency, relations, aliases, slug rules, and assets. */
export function validateProject(config: ScribeConfig): ValidateResult {
  const issues: ValidateIssue[] = [];
  const project = createProject(config);
  const storePath = project.storePath;

  if (!fs.existsSync(storePath)) {
    issues.push({
      level: "error",
      message: `Missing store.sqlite at ${storePath}`,
    });
    return { ok: false, issues };
  }

  const db = openStore(config, "readonly");

  for (const type of config.types) {
    const enSlugs = listEnSlugs(config.rootDir, type.contentDir);
    const englishSlugs = new Set(enSlugs);

    if (!type.translate && isRoutableType(type)) {
      issues.push({
        level: "warning",
        contentType: type.id,
        message: `No translate config on content type "${type.id}" — using Scribe defaults`,
      });
    }

    for (const enSlug of enSlugs) {
      const enDoc = readEnDocument(config, type, enSlug);
      if (!enDoc) {
        issues.push({
          level: "error",
          contentType: type.id,
          enSlug,
          message: "Failed to parse EN document",
        });
        continue;
      }

      const crossIssues =
        type.crossValidate?.(enDoc.frontmatter as never, {
          locale: config.defaultLocale,
          defaultLocale: config.defaultLocale,
          slug: enSlug,
          enSlug,
          knownLocales: config.locales,
          englishSlugs,
        }) ?? [];
      for (const issue of crossIssues) {
        issues.push({
          level: issue.level,
          contentType: type.id,
          enSlug,
          field: issue.field,
          message: issue.message,
        });
      }

      for (const issue of validateDocumentAssets(config, {
        contentType: type.id,
        enSlug,
        frontmatter: enDoc.frontmatter,
        body: enDoc.content,
      })) {
        issues.push(issue);
      }

      for (const locale of config.locales) {
        if (locale === config.defaultLocale) continue;
        const row = getTranslation(db, type.id, enSlug, locale);
        if (!row) continue;

        const localeFm = JSON.parse(row.frontmatter_json) as Record<string, unknown>;
        for (const issue of validateLocaleBuiltinFields(localeFm)) {
          issues.push({
            level: issue.level,
            contentType: type.id,
            enSlug,
            locale,
            field: issue.field,
            message: issue.message,
          });
        }

        for (const issue of validateDocumentAssets(config, {
          contentType: type.id,
          enSlug,
          locale,
          frontmatter: localeFm,
          body: row.body,
        })) {
          issues.push(issue);
        }
      }
    }

    try {
      project.getType(type.id).load();
    } catch (error) {
      issues.push({
        level: "error",
        contentType: type.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  db.close();

  const aliasIndex = buildGlobalAliasIndex(project);
  for (const issue of aliasIndex.issues) {
    issues.push({
      level: issue.level,
      contentType: issue.contentTypeId,
      enSlug: issue.enSlug,
      field: issue.field,
      message: issue.message,
    });
  }

  for (const issue of validateAliasRedirectChains(project)) {
    issues.push({
      level: issue.level,
      contentType: issue.contentTypeId,
      enSlug: issue.enSlug,
      field: issue.field,
      message: issue.message,
    });
  }

  for (const issue of validateAliasCoverage(project)) {
    issues.push({
      level: issue.level,
      contentType: issue.contentTypeId,
      enSlug: issue.enSlug,
      field: issue.field,
      message: issue.message,
    });
  }

  for (const issue of validateRelations(project)) {
    issues.push({
      level: issue.level,
      contentType: issue.contentTypeId,
      enSlug: issue.enSlug,
      field: issue.field,
      message: issue.message,
    });
  }

  const dbForSuffix = openStore(config, "readonly");
  try {
    for (const issue of validateTranslationSlugSuffixes(config, dbForSuffix)) {
      issues.push({
        level: "warning",
        contentType: issue.contentTypeId,
        enSlug: issue.enSlug,
        locale: issue.locale,
        field: "slug",
        message: issue.message,
      });
    }
  } finally {
    dbForSuffix.close();
  }

  return { ok: issues.every((i) => i.level !== "error"), issues };
}
