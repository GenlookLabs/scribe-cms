import fs from "node:fs";
import path from "node:path";
import type { ScribeConfig, ScribeProject } from "../core/types.js";
import { enFileExists, listEnSlugs } from "../core/alias-helpers.js";
import { createUrlBuilder, isRoutableType } from "../i18n/build-url.js";
import {
  loadAllTypeRedirects,
  loadTypeRedirectsFile,
  TYPE_REDIRECTS_FILENAME,
} from "../redirects/load-type-redirects.js";
import type { ParsedRedirectEntry } from "../redirects/redirect-schema.js";
import type { ValidateIssue } from "../validate/validate-project.js";

function liveDocExists(config: ScribeConfig, typeId: string, enSlug: string): boolean {
  const type = config.types.find((entry) => entry.id === typeId);
  if (!type) return false;
  return enFileExists(config, type, enSlug);
}

function resolveRedirectTarget(
  project: ScribeProject,
  sourceTypeId: string,
  entry: ParsedRedirectEntry,
): { typeId: string; enSlug: string } | null {
  if (entry.kind === "anywhere") return null;
  if (entry.kind === "cross-type") {
    return { typeId: entry.toType!, enSlug: entry.toSlug! };
  }
  return { typeId: sourceTypeId, enSlug: entry.toSlug! };
}

function matchRoutableTarget(
  project: ScribeProject,
  toUrl: string,
): { typeId: string; enSlug: string } | null {
  const urlBuilder = createUrlBuilder(project.config);
  for (const type of project.config.types) {
    if (!type.path) continue;
    const enSlug = urlBuilder.extractSlugFromResolvedPath(type.path, toUrl);
    if (enSlug && liveDocExists(project.config, type.id, enSlug)) {
      return { typeId: type.id, enSlug };
    }
  }
  return null;
}

export function validateTypeRedirects(project: ScribeProject): ValidateIssue[] {
  const issues: ValidateIssue[] = [];
  const globalFrom = new Map<string, { typeId: string; filePath: string }>();

  for (const type of project.config.types) {
    const filePath = path.join(project.config.rootDir, type.contentDir, TYPE_REDIRECTS_FILENAME);
    if (!fs.existsSync(filePath)) continue;

    let loaded;
    try {
      loaded = loadTypeRedirectsFile(project.config, type);
    } catch (error) {
      issues.push({
        level: "error",
        contentType: type.id,
        field: TYPE_REDIRECTS_FILENAME,
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (!loaded) continue;

    if (!isRoutableType(type)) {
      issues.push({
        level: "error",
        contentType: type.id,
        field: TYPE_REDIRECTS_FILENAME,
        message: `Redirects are only supported on routable content types (missing path)`,
      });
      continue;
    }

    for (const entry of loaded.entries) {
      for (const from of entry.fromSlugs) {
        if (from === entry.toSlug) {
          issues.push({
            level: "error",
            contentType: type.id,
            enSlug: from,
            field: TYPE_REDIRECTS_FILENAME,
            message: `Redirect source "${from}" must not equal its target slug`,
          });
        }

        if (liveDocExists(project.config, type.id, from)) {
          issues.push({
            level: "error",
            contentType: type.id,
            enSlug: from,
            field: TYPE_REDIRECTS_FILENAME,
            message: `Redirect source "${from}" still has a live EN file — delete or rename the MDX first`,
          });
        }

        const existing = globalFrom.get(from);
        if (existing && existing.typeId !== type.id) {
          issues.push({
            level: "error",
            contentType: type.id,
            enSlug: from,
            field: TYPE_REDIRECTS_FILENAME,
            message: `Redirect source "${from}" is already claimed by ${existing.typeId}`,
          });
        } else if (existing) {
          issues.push({
            level: "error",
            contentType: type.id,
            enSlug: from,
            field: TYPE_REDIRECTS_FILENAME,
            message: `Duplicate redirect source "${from}" in ${TYPE_REDIRECTS_FILENAME}`,
          });
        } else {
          globalFrom.set(from, { typeId: type.id, filePath: loaded.filePath });
        }
      }

      if (entry.kind === "cross-type") {
        const targetType = project.config.types.find((candidate) => candidate.id === entry.toType);
        if (!targetType) {
          issues.push({
            level: "error",
            contentType: type.id,
            field: TYPE_REDIRECTS_FILENAME,
            message: `Unknown redirect target type "${entry.toType}"`,
          });
          continue;
        }
        if (!isRoutableType(targetType)) {
          issues.push({
            level: "error",
            contentType: type.id,
            field: TYPE_REDIRECTS_FILENAME,
            message: `Redirect target type "${entry.toType}" is not routable (missing path)`,
          });
          continue;
        }
      }

      const target = resolveRedirectTarget(project, type.id, entry);
      if (target) {
        if (!liveDocExists(project.config, target.typeId, target.enSlug)) {
          issues.push({
            level: "error",
            contentType: type.id,
            field: TYPE_REDIRECTS_FILENAME,
            message: `Redirect target ${target.typeId}/${target.enSlug} does not exist`,
          });
        }
        continue;
      }

      if (entry.kind === "anywhere" && entry.toUrl?.startsWith("/")) {
        const matched = matchRoutableTarget(project, entry.toUrl);
        if (matched && !liveDocExists(project.config, matched.typeId, matched.enSlug)) {
          issues.push({
            level: "error",
            contentType: type.id,
            field: TYPE_REDIRECTS_FILENAME,
            message: `Redirect toUrl "${entry.toUrl}" does not resolve to a live document`,
          });
        }
      }
    }
  }

  const allLoaded = loadAllTypeRedirects(project.config);
  for (const file of allLoaded) {
    for (const entry of file.entries) {
      if (entry.kind === "anywhere" || !entry.toSlug) continue;
      const targetTypeId = entry.kind === "cross-type" ? entry.toType! : file.contentTypeId;
      const targetType = project.config.types.find((type) => type.id === targetTypeId);
      if (!targetType?.path) continue;

      for (const from of entry.fromSlugs) {
        if (globalFrom.get(from)?.typeId !== file.contentTypeId) continue;
        const chainTarget = globalFrom.get(entry.toSlug);
        if (chainTarget) {
          issues.push({
            level: "error",
            contentType: file.contentTypeId,
            enSlug: from,
            field: TYPE_REDIRECTS_FILENAME,
            message: `Redirect chain detected: "${from}" → "${entry.toSlug}" → existing redirect source`,
          });
        }
      }
    }
  }

  return issues;
}
