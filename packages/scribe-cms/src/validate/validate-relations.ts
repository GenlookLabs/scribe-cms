import fs from "node:fs";
import path from "node:path";
import type { ScribeConfig, ScribeProject } from "../core/types.js";
import { listEnSlugs } from "../core/alias-helpers.js";
import { listRelationFields } from "../core/introspect-schema.js";
import { readEnDocument } from "../loader/create-loader.js";
import { isPublishableContentFile } from "../loader/normalize-en.js";

export interface RelationValidateIssue {
  contentTypeId: string;
  enSlug: string;
  locale?: string;
  field: string;
  message: string;
  /**
   * Dangling required single relations are errors (`related()` would throw at
   * render); dangling optional/multiple relations degrade gracefully to
   * null/dropped items, so they only warn.
   */
  level: "error" | "warning";
}

function getAtPath(obj: Record<string, unknown>, fieldPath: string[]): unknown {
  let current: unknown = obj;
  for (const segment of fieldPath) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function buildEnSlugIndex(config: ScribeConfig): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const type of config.types) {
    const slugs = new Set(listEnSlugs(config.rootDir, type.contentDir));
    index.set(type.id, slugs);
  }
  return index;
}

function listEnSlugsForType(rootDir: string, contentDir: string): string[] {
  const dir = path.join(rootDir, contentDir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter(isPublishableContentFile)
    .map((f) => f.replace(/\.(md|mdx)$/, ""));
}

/**
 * Warn when a relation field references a slug that does not exist in the target type.
 */
export function validateRelations(project: ScribeProject): RelationValidateIssue[] {
  const { config } = project;
  const slugIndex = buildEnSlugIndex(config);
  const issues: RelationValidateIssue[] = [];

  const typeIds = new Set(config.types.map((t) => t.id));

  for (const type of config.types) {
    const relationFields = listRelationFields(type.schema);
    if (relationFields.length === 0) continue;

    for (const enSlug of listEnSlugsForType(config.rootDir, type.contentDir)) {
      const doc = readEnDocument(config, type, enSlug);
      if (!doc) continue;

      for (const fieldMeta of relationFields) {
        const targetTypeId = fieldMeta.relationTarget!;
        const danglingLevel =
          fieldMeta.relationOptional || fieldMeta.relationMultiple ? "warning" : "error";
        if (!typeIds.has(targetTypeId)) {
          issues.push({
            contentTypeId: type.id,
            enSlug,
            field: fieldMeta.path.join("."),
            message: `Relation target type "${targetTypeId}" is not registered`,
            level: "error",
          });
          continue;
        }

        const value = getAtPath(doc.frontmatter as Record<string, unknown>, fieldMeta.path);
        if (value === undefined || value === null || value === "") continue;

        const targetSlugs = slugIndex.get(targetTypeId) ?? new Set<string>();
        const fieldLabel = fieldMeta.path.join(".");

        if (fieldMeta.relationMultiple) {
          if (!Array.isArray(value)) continue;
          for (const slug of value) {
            if (typeof slug !== "string" || !slug) continue;
            if (!targetSlugs.has(slug)) {
              issues.push({
                contentTypeId: type.id,
                enSlug,
                field: fieldLabel,
                message: `${fieldLabel} references "${slug}" — no ${targetTypeId} doc with that slug`,
                level: danglingLevel,
              });
            }
          }
        } else if (typeof value === "string") {
          if (!targetSlugs.has(value)) {
            issues.push({
              contentTypeId: type.id,
              enSlug,
              field: fieldLabel,
              message: `${fieldLabel} references "${value}" — no ${targetTypeId} doc with slug "${value}"`,
              level: danglingLevel,
            });
          }
        }
      }
    }
  }

  return issues;
}
