import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { listRelationFields, type SchemaFieldMeta } from "../core/introspect-schema.js";
import type { ScribeProject } from "../core/types.js";
import { bumpContentVersion } from "../loader/create-loader.js";
import { openStore } from "../storage/sqlite.js";
import {
  deleteEnSnapshotsForEnSlug,
  deleteTranslationsForEnSlug,
} from "../storage/translations.js";
import { deletedDocs, isPlanBlocked, type DeletionPlan } from "./plan.js";

export interface ExecuteDeletionResult {
  /** EN files removed from disk. */
  deletedFiles: string[];
  /** Asset files removed from disk. */
  deletedAssets: string[];
  /** EN files rewritten to drop a detached reference. */
  detachedFiles: string[];
  /** Translation rows removed from the store. */
  translationsDeleted: number;
  /** EN snapshot rows removed from the store. */
  snapshotsDeleted: number;
}

/** Locate the on-disk EN file for a document, trying `.mdx` then `.md`. */
function enFilePath(rootDir: string, contentDir: string, enSlug: string): string | null {
  for (const ext of [".mdx", ".md"]) {
    const candidate = path.join(rootDir, contentDir, `${enSlug}${ext}`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Rewrite the frontmatter block of a raw MDX string, leaving the body bytes
 * exactly as they were. The YAML is re-serialized (minor reformatting is
 * acceptable); everything after the closing `---` line is preserved verbatim.
 */
function rewriteFrontmatter(raw: string, data: Record<string, unknown>): string {
  const match = raw.match(/^(﻿)?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/);
  if (!match) {
    throw new Error("Cannot rewrite frontmatter: no leading YAML block found");
  }
  const bom = match[1] ?? "";
  const body = raw.slice(match[0].length);
  const serialized = matter.stringify("", data);
  const blockMatch = serialized.match(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n/);
  const block = blockMatch ? blockMatch[0] : serialized;
  return `${bom}${block}${body}`;
}

/** Remove a detached slug at a relation field path (handles arrays and `*` paths). */
function removeSlugAtPath(
  container: unknown,
  remaining: string[],
  removedSlug: string,
  multiple: boolean,
): void {
  const [head, ...rest] = remaining;
  if (head === undefined) return;
  if (typeof container !== "object" || container === null || Array.isArray(container)) return;
  const record = container as Record<string, unknown>;
  if (rest.length === 0) {
    if (multiple) {
      const value = record[head];
      if (Array.isArray(value)) {
        record[head] = value.filter((slug) => slug !== removedSlug);
      }
    } else if (record[head] === removedSlug) {
      // Optional single relation: clear it only when it points at the deleted target.
      delete record[head];
    }
    return;
  }
  if (rest[0] === "*") {
    const arr = record[head];
    if (Array.isArray(arr)) {
      for (const item of arr) removeSlugAtPath(item, rest.slice(1), removedSlug, multiple);
    }
    return;
  }
  removeSlugAtPath(record[head], rest, removedSlug, multiple);
}

/**
 * Execute a deletion plan: remove EN files, delete asset files, rewrite detach
 * references, and clean up store rows. Refuses to run while the plan is blocked.
 * Performs exactly the plan and nothing else.
 */
export function executeDeletionPlan(
  project: ScribeProject,
  plan: DeletionPlan,
): ExecuteDeletionResult {
  if (isPlanBlocked(plan)) {
    throw new Error("Refusing to execute a blocked deletion plan");
  }

  const config = project.config;
  const result: ExecuteDeletionResult = {
    deletedFiles: [],
    deletedAssets: [],
    detachedFiles: [],
    translationsDeleted: 0,
    snapshotsDeleted: 0,
  };

  // 1. Detach rewrites first (grouped by referring file), before the referenced
  //    files vanish. Body bytes are preserved.
  const detachesByFile = new Map<string, typeof plan.detaches>();
  for (const detach of plan.detaches) {
    const key = `${detach.typeId} ${detach.enSlug}`;
    const list = detachesByFile.get(key) ?? [];
    list.push(detach);
    detachesByFile.set(key, list);
  }
  for (const [, detaches] of detachesByFile) {
    const { typeId, enSlug } = detaches[0]!;
    const type = project.getType(typeId);
    const file = enFilePath(config.rootDir, type.config.contentDir, enSlug);
    if (!file) continue;
    const fieldByPath = new Map<string, SchemaFieldMeta>(
      listRelationFields(type.config.schema).map((f) => [f.path.join("."), f]),
    );
    const raw = fs.readFileSync(file, "utf8");
    // gray-matter caches its parse result per input string; clone before mutating
    // so we never corrupt that shared object.
    const data = structuredClone(matter(raw).data) as Record<string, unknown>;
    for (const detach of detaches) {
      const field = fieldByPath.get(detach.fieldPath);
      if (!field) continue;
      removeSlugAtPath(
        data,
        detach.fieldPath.split("."),
        detach.removedSlug,
        Boolean(field.relationMultiple),
      );
    }
    fs.writeFileSync(file, rewriteFrontmatter(raw, data), "utf8");
    result.detachedFiles.push(file);
  }

  // 2. Delete asset files (only those the plan marks for deletion).
  const assetsDir = config.assets?.assetsPath ?? config.assetsPath;
  for (const asset of plan.assets) {
    if (asset.action !== "delete") continue;
    if (!assetsDir) continue;
    const root = path.resolve(assetsDir);
    const relative = asset.path.replace(/^\/+/, "");
    const abs = path.resolve(root, relative);
    const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
    if (abs !== root && !abs.startsWith(rootWithSep)) continue;
    if (fs.existsSync(abs)) {
      fs.rmSync(abs, { force: true });
      result.deletedAssets.push(abs);
    }
  }

  // 3. Delete EN files.
  for (const doc of deletedDocs(plan)) {
    const type = project.getType(doc.typeId);
    const file = enFilePath(config.rootDir, type.config.contentDir, doc.enSlug);
    if (file && fs.existsSync(file)) {
      fs.rmSync(file, { force: true });
      result.deletedFiles.push(file);
    }
  }

  // 4. Store cleanup: translation rows + EN snapshots for every deleted doc.
  const db = openStore(config, "readwrite");
  try {
    for (const doc of deletedDocs(plan)) {
      result.translationsDeleted += deleteTranslationsForEnSlug(db, doc.typeId, doc.enSlug);
      result.snapshotsDeleted += deleteEnSnapshotsForEnSlug(db, doc.typeId, doc.enSlug);
    }
  } finally {
    db.close();
  }

  // Force every in-process content loader to rebuild on next read so the deleted
  // (and detached) docs disappear immediately, bypassing the dev revalidation
  // window and the studio's fingerprint-keyed derived cache.
  bumpContentVersion();

  return result;
}
