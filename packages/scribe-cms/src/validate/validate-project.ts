import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import type { ContentTypeConfig, ScribeConfig } from "../core/types.js";
import { createProject } from "../create-project.js";
import { validateTypeRedirects } from "./validate-redirects.js";
import { validateLocaleBuiltinFields } from "../core/builtin-fields.js";
import { readEnDocument } from "../loader/create-loader.js";
import { isPublishableContentFile } from "../loader/normalize-en.js";
import { openStore } from "../storage/sqlite.js";
import { isRoutableType } from "../i18n/build-url.js";
import { getTranslation } from "../storage/translations.js";
import { validateRelations } from "./validate-relations.js";
import {
  collectDeclaredAssetPaths,
  validateDeclaredAssetFields,
  validateDocumentAssets,
} from "./validate-assets.js";
import { validateTranslationSlugSuffixes } from "./validate-slug-suffix.js";
import { prepareTranslatedMdxBody, validateMdxBody } from "../translate/validate-mdx-body.js";

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

/**
 * Read the raw MDX body of a bodyless-type EN entry (the loader zeroes it, so we
 * re-read the source) and report an error when it holds anything but whitespace.
 */
function validateBodylessEntry(
  issues: ValidateIssue[],
  config: ScribeConfig,
  type: ContentTypeConfig,
  enSlug: string,
): void {
  const contentDir = path.join(config.rootDir, type.contentDir);
  for (const ext of [".mdx", ".md"]) {
    const filePath = path.join(contentDir, `${enSlug}${ext}`);
    if (!fs.existsSync(filePath)) continue;
    const body = matter(fs.readFileSync(filePath, "utf8")).content;
    if (body.trim().length > 0) {
      issues.push({
        level: "error",
        contentType: type.id,
        enSlug,
        field: "body",
        message: `type "${type.id}" is frontmatter-only (body: false) but the entry has body content`,
      });
    }
    return;
  }
}

function validateDocumentMdxBody(
  issues: ValidateIssue[],
  input: {
    contentType: string;
    enSlug: string;
    locale: string;
    body: string;
  },
): void {
  const preparedBody = prepareTranslatedMdxBody(input.body).body;
  const mdxValidation = validateMdxBody(preparedBody);
  if (!mdxValidation.ok) {
    issues.push({
      level: "error",
      contentType: input.contentType,
      enSlug: input.enSlug,
      locale: input.locale,
      field: "body",
      message: `Invalid MDX: ${mdxValidation.error}`,
    });
  }
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

      // Declared asset fields are EN-sourced structural: validate on EN only.
      // Locale docs never store them, so they'd otherwise read as "required missing".
      for (const issue of validateDeclaredAssetFields(config, {
        contentType: type.id,
        enSlug,
        frontmatter: enDoc.frontmatter as Record<string, unknown>,
        schema: type.schema,
      })) {
        issues.push(issue);
      }

      // Skip declared-asset web paths in the heuristic pass (EN + locales) to
      // avoid double reporting the same missing file at different levels.
      const declaredAssetPaths = collectDeclaredAssetPaths(
        enDoc.frontmatter as Record<string, unknown>,
        enSlug,
        type.schema,
      );

      for (const issue of validateDocumentAssets(
        config,
        {
          contentType: type.id,
          enSlug,
          frontmatter: enDoc.frontmatter,
          body: enDoc.content,
        },
        declaredAssetPaths,
      )) {
        issues.push(issue);
      }

      if (type.body === false) {
        // Frontmatter-only type: no MDX body work; instead flag a stray body.
        validateBodylessEntry(issues, config, type, enSlug);
      } else {
        validateDocumentMdxBody(issues, {
          contentType: type.id,
          enSlug,
          locale: config.defaultLocale,
          body: enDoc.content,
        });
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

        const preparedBody = prepareTranslatedMdxBody(row.body).body;
        for (const issue of validateDocumentAssets(
          config,
          {
            contentType: type.id,
            enSlug,
            locale,
            frontmatter: localeFm,
            body: preparedBody,
          },
          declaredAssetPaths,
        )) {
          issues.push(issue);
        }

        if (type.body !== false) {
          validateDocumentMdxBody(issues, {
            contentType: type.id,
            enSlug,
            locale,
            body: row.body,
          });
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

  for (const issue of validateTypeRedirects(project)) {
    issues.push(issue);
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
