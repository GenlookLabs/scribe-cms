import fs from "node:fs";
import path from "node:path";
import type { ScribeConfig } from "../core/types.js";
import { isRoutableType } from "../i18n/build-url.js";
import { extractInlineTokens } from "../inline/tokens.js";
import { readEnDocument } from "../loader/create-loader.js";
import { isPublishableContentFile } from "../loader/normalize-en.js";
import { buildEnSlugIndex } from "./validate-relations.js";
import type { ValidateIssue } from "./validate-project.js";

function listEnSlugs(rootDir: string, contentDir: string): string[] {
  const dir = path.join(rootDir, contentDir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter(isPublishableContentFile)
    .map((f) => f.replace(/\.(md|mdx)$/, ""));
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every((v) => typeof v === "string");
}

function assetFileExists(config: ScribeConfig, webPath: string): boolean {
  const assetsPath = config.assetsPath;
  if (!assetsPath) return true; // no asset system configured: cannot check
  return fs.existsSync(path.join(assetsPath, webPath.replace(/^\//, "")));
}

/**
 * Validate `${{...}}` inline tokens in EN document bodies. Entry-level issues so
 * the studio badges pick them up automatically. Covers malformed syntax and each
 * token kind's referential integrity (relation target/slug, asset file, var
 * key). Static tokens are always valid.
 */
export function validateInlineTokens(config: ScribeConfig): ValidateIssue[] {
  const issues: ValidateIssue[] = [];
  const slugIndex = buildEnSlugIndex(config);
  const typeIds = new Set(config.types.map((t) => t.id));
  const typeById = new Map(config.types.map((t) => [t.id, t]));

  for (const type of config.types) {
    for (const enSlug of listEnSlugs(config.rootDir, type.contentDir)) {
      const doc = readEnDocument(config, type, enSlug);
      if (!doc) continue;

      const { tokens, malformed } = extractInlineTokens(doc.content);

      for (const bad of malformed) {
        issues.push({
          level: "error",
          contentType: type.id,
          enSlug,
          field: "body",
          message: `Malformed inline token (${bad.reason}): ${bad.raw}`,
        });
      }

      let varsReported = false;
      const vars = (doc.frontmatter as Record<string, unknown>).vars;

      for (const token of tokens) {
        switch (token.kind) {
          case "static":
            break;

          case "relation": {
            if (!typeIds.has(token.targetTypeId)) {
              issues.push({
                level: "error",
                contentType: type.id,
                enSlug,
                field: "body",
                message: `Inline relation token targets unknown type "${token.targetTypeId}"`,
              });
              break;
            }
            const targetSlugs = slugIndex.get(token.targetTypeId) ?? new Set<string>();
            if (!targetSlugs.has(token.enSlug)) {
              issues.push({
                level: "error",
                contentType: type.id,
                enSlug,
                field: "body",
                message: `Inline relation token references "${token.enSlug}", but no ${token.targetTypeId} doc has that slug`,
              });
              break;
            }
            if (token.mode === "href") {
              const targetType = typeById.get(token.targetTypeId)!;
              if (!isRoutableType(targetType)) {
                issues.push({
                  level: "error",
                  contentType: type.id,
                  enSlug,
                  field: "body",
                  message: `Inline relation token resolves a URL for "${token.targetTypeId}", which has no path template (not routable)`,
                });
              }
            }
            break;
          }

          case "asset": {
            if (!assetFileExists(config, token.webPath)) {
              issues.push({
                level: "error",
                contentType: type.id,
                enSlug,
                field: "body",
                message: `Inline asset token references ${token.webPath}, which is missing on disk`,
              });
            }
            break;
          }

          case "var": {
            if (vars !== undefined && !isStringRecord(vars)) {
              if (!varsReported) {
                varsReported = true;
                issues.push({
                  level: "error",
                  contentType: type.id,
                  enSlug,
                  field: "vars",
                  message: `Frontmatter "vars" must be a string-to-string map`,
                });
              }
              break;
            }
            if (!isStringRecord(vars) || !(token.key in vars)) {
              issues.push({
                level: "error",
                contentType: type.id,
                enSlug,
                field: "body",
                message: `Inline var token references "${token.key}", absent from this document's vars map`,
              });
            }
            break;
          }
        }
      }
    }
  }

  return issues;
}
