import type { OnTargetDelete } from "../core/field.js";
import {
  listAssetFields,
  listRelationFields,
  type SchemaFieldMeta,
} from "../core/introspect-schema.js";
import type { ScribeDocument, ScribeProject } from "../core/types.js";
import { walkAssetValues } from "../core/walk-asset-values.js";
import { extractInlineTokens } from "../inline/tokens.js";
import { openStore } from "../storage/sqlite.js";
import {
  countEnSnapshotsForEnSlug,
  countTranslationsForEnSlug,
} from "../storage/translations.js";

/**
 * Deletion planning for `scribe delete` (CLI + studio). One module computes the
 * full impact of deleting an entry — transitive cascades, reference detaches,
 * blockers, asset files, and store rows — so both surfaces render and execute
 * exactly the same plan. See `docs/deletion.md`.
 */

/** The requested deletion (and any title for display). */
export interface DeletionRoot {
  typeId: string;
  enSlug: string;
  title?: string;
}

/** A document deleted transitively because it cascaded from a deleted target. */
export interface DeletionCascade {
  typeId: string;
  enSlug: string;
  /** Human-readable edge that pulled it in, e.g. `model=alice`. */
  via: string;
}

/** A surviving document whose reference to a deleted target is removed. */
export interface DeletionDetach {
  typeId: string;
  enSlug: string;
  fieldPath: string;
  removedSlug: string;
}

/** A document that prevents the deletion (restrict, or a required single relation). */
export interface DeletionBlocker {
  typeId: string;
  enSlug: string;
  fieldPath: string;
  reason: "restrict" | "required-single";
}

/** An asset file owned by a deleted document. */
export interface DeletionAsset {
  path: string;
  ownerTypeId: string;
  ownerEnSlug: string;
  action: "delete" | "keep";
  /** Why an asset is kept: config `onDelete: "keep"`, or a shared path referenced elsewhere. */
  reason?: "config-keep" | "shared";
}

/** Per-document store row counts removed by the deletion. */
export interface DeletionStoreCounts {
  typeId: string;
  enSlug: string;
  translations: number;
  snapshots: number;
}

/**
 * A surviving document whose MDX body references (via `${{relation:...}}`) a doc
 * in the deletion set. Body relation tokens never cascade, detach, or block —
 * they will simply dangle and become validation errors after the deletion.
 */
export interface BodyRefWarning {
  typeId: string;
  enSlug: string;
  targetTypeId: string;
  targetEnSlug: string;
}

export interface DeletionPlan {
  roots: DeletionRoot[];
  cascades: DeletionCascade[];
  detaches: DeletionDetach[];
  blocked: DeletionBlocker[];
  assets: DeletionAsset[];
  store: DeletionStoreCounts[];
  /** Warn-only: surviving body references that will dangle after deletion. */
  bodyRefWarnings: BodyRefWarning[];
}

/** Whether a plan can be executed (no blockers). */
export function isPlanBlocked(plan: DeletionPlan): boolean {
  return plan.blocked.length > 0;
}

/** Every document the plan removes (roots first, then transitive cascades). */
export function deletedDocs(plan: DeletionPlan): Array<{ typeId: string; enSlug: string }> {
  return [
    ...plan.roots.map((r) => ({ typeId: r.typeId, enSlug: r.enSlug })),
    ...plan.cascades.map((c) => ({ typeId: c.typeId, enSlug: c.enSlug })),
  ];
}

function docKey(typeId: string, enSlug: string): string {
  return `${typeId}\u0000${enSlug}`;
}

/** Collect the EN slugs a relation field points at (handles arrays and `*` paths). */
function relationSlugsAt(frontmatter: Record<string, unknown>, path: string[]): string[] {
  const out: string[] = [];
  const walk = (container: unknown, remaining: string[]): void => {
    const [head, ...rest] = remaining;
    if (head === undefined) return;
    if (typeof container !== "object" || container === null || Array.isArray(container)) return;
    const record = container as Record<string, unknown>;
    if (rest.length === 0) {
      const value = record[head];
      if (Array.isArray(value)) {
        for (const slug of value) if (typeof slug === "string" && slug) out.push(slug);
      } else if (typeof value === "string" && value) {
        out.push(value);
      }
      return;
    }
    if (rest[0] === "*") {
      const arr = record[head];
      if (Array.isArray(arr)) for (const item of arr) walk(item, rest.slice(1));
      return;
    }
    walk(record[head], rest);
  };
  walk(frontmatter, path);
  return out;
}

/** Collect the source web paths a declared asset field resolves to (materializing templates). */
function assetValuesAt(
  frontmatter: Record<string, unknown>,
  field: SchemaFieldMeta,
  enSlug: string,
): string[] {
  const out: string[] = [];
  // For a multiple field each element is collected; the field-level summary
  // visit (raw = the array) and any absent visit are ignored (not strings).
  walkAssetValues(
    frontmatter,
    field.path,
    ({ raw }) => {
      if (typeof raw === "string" && raw) out.push(raw);
      else if (raw === undefined && field.assetTemplate) {
        out.push(field.assetTemplate.split("{slug}").join(enSlug));
      }
    },
    { multiple: field.assetMultiple },
  );
  return out;
}

interface Referrer {
  typeId: string;
  enSlug: string;
  fieldPath: string;
  multiple: boolean;
  optional: boolean;
  onTargetDelete: OnTargetDelete;
}

interface DocRecord {
  typeId: string;
  enSlug: string;
  frontmatter: Record<string, unknown>;
}

/**
 * Compute the full deletion plan for one entry. Reads source (unresolved)
 * frontmatter from the project's cached document lists — no side effects. Store
 * row counts are read from the (read-only) SQLite store when it exists.
 */
export function buildDeletionPlan(
  project: ScribeProject,
  typeId: string,
  enSlug: string,
): DeletionPlan {
  const rootType = (() => {
    try {
      return project.getType(typeId);
    } catch {
      return null;
    }
  })();
  if (!rootType) {
    throw new Error(`Unknown content type "${typeId}"`);
  }
  const rootDoc = rootType.get(enSlug);
  if (!rootDoc) {
    throw new Error(`No ${typeId} entry "${enSlug}"`);
  }

  // Snapshot every document's source frontmatter, plus per-type field metadata.
  const docByKey = new Map<string, DocRecord>();
  const relationFieldsByType = new Map<string, SchemaFieldMeta[]>();
  const assetFieldsByType = new Map<string, SchemaFieldMeta[]>();
  const referrers = new Map<string, Referrer[]>();
  const assetRefs = new Map<string, Set<string>>();
  // Every `${{relation:...}}` body reference, collected up front; filtered
  // against the deletion set once it is known.
  const bodyRelationRefs: BodyRefWarning[] = [];

  for (const type of project.listTypes()) {
    const relFields = listRelationFields(type.config.schema);
    const assetFields = listAssetFields(type.config.schema);
    relationFieldsByType.set(type.id, relFields);
    assetFieldsByType.set(type.id, assetFields);
    for (const doc of type.list() as ScribeDocument[]) {
      const frontmatter = doc.frontmatter as Record<string, unknown>;
      docByKey.set(docKey(type.id, doc.enSlug), {
        typeId: type.id,
        enSlug: doc.enSlug,
        frontmatter,
      });
      // Reverse relation index: (targetType, targetSlug) -> referrers.
      for (const field of relFields) {
        const target = field.relationTarget;
        if (!target) continue;
        for (const slug of relationSlugsAt(frontmatter, field.path)) {
          const list = referrers.get(docKey(target, slug)) ?? [];
          list.push({
            typeId: type.id,
            enSlug: doc.enSlug,
            fieldPath: field.path.join("."),
            multiple: Boolean(field.relationMultiple),
            optional: Boolean(field.relationOptional),
            onTargetDelete: field.relationOnTargetDelete ?? "restrict",
          });
          referrers.set(docKey(target, slug), list);
        }
      }
      // Asset reference graph (declared fields only), keyed by source web path.
      for (const field of assetFields) {
        for (const webPath of assetValuesAt(frontmatter, field, doc.enSlug)) {
          const set = assetRefs.get(webPath) ?? new Set<string>();
          set.add(docKey(type.id, doc.enSlug));
          assetRefs.set(webPath, set);
        }
      }
      // Body relation tokens: recorded now, filtered against the deletion set later.
      for (const token of extractInlineTokens(doc.content).tokens) {
        if (token.kind === "relation") {
          bodyRelationRefs.push({
            typeId: type.id,
            enSlug: doc.enSlug,
            targetTypeId: token.targetTypeId,
            targetEnSlug: token.enSlug,
          });
        }
      }
    }
  }

  // ---- Transitive cascade (cycle-safe: visited keyed by type + enSlug). ----
  const deleted = new Map<string, { typeId: string; enSlug: string; via?: string }>();
  deleted.set(docKey(typeId, enSlug), { typeId, enSlug });
  const queue: Array<{ typeId: string; enSlug: string }> = [{ typeId, enSlug }];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const ref of referrers.get(docKey(current.typeId, current.enSlug)) ?? []) {
      if (ref.onTargetDelete !== "cascade") continue;
      const refKey = docKey(ref.typeId, ref.enSlug);
      if (deleted.has(refKey)) continue;
      deleted.set(refKey, {
        typeId: ref.typeId,
        enSlug: ref.enSlug,
        via: `${ref.fieldPath}=${current.enSlug}`,
      });
      queue.push({ typeId: ref.typeId, enSlug: ref.enSlug });
    }
  }

  // ---- Detaches + blockers over surviving referrers of every deleted doc. ----
  const detaches: DeletionDetach[] = [];
  const blocked: DeletionBlocker[] = [];
  const seenDetach = new Set<string>();
  const seenBlock = new Set<string>();
  for (const del of deleted.values()) {
    for (const ref of referrers.get(docKey(del.typeId, del.enSlug)) ?? []) {
      // A referrer that is itself deleted loses the reference with its own file.
      if (deleted.has(docKey(ref.typeId, ref.enSlug))) continue;
      if (ref.onTargetDelete === "restrict") {
        const k = `${ref.typeId}\u0000${ref.enSlug}\u0000${ref.fieldPath}\u0000restrict`;
        if (!seenBlock.has(k)) {
          seenBlock.add(k);
          blocked.push({
            typeId: ref.typeId,
            enSlug: ref.enSlug,
            fieldPath: ref.fieldPath,
            reason: "restrict",
          });
        }
      } else if (ref.onTargetDelete === "detach") {
        const requiredSingle = !ref.multiple && !ref.optional;
        if (requiredSingle) {
          const k = `${ref.typeId}\u0000${ref.enSlug}\u0000${ref.fieldPath}\u0000required-single`;
          if (!seenBlock.has(k)) {
            seenBlock.add(k);
            blocked.push({
              typeId: ref.typeId,
              enSlug: ref.enSlug,
              fieldPath: ref.fieldPath,
              reason: "required-single",
            });
          }
        } else {
          const k = `${ref.typeId}\u0000${ref.enSlug}\u0000${ref.fieldPath}\u0000${del.enSlug}`;
          if (!seenDetach.has(k)) {
            seenDetach.add(k);
            detaches.push({
              typeId: ref.typeId,
              enSlug: ref.enSlug,
              fieldPath: ref.fieldPath,
              removedSlug: del.enSlug,
            });
          }
        }
      }
      // cascade referrers are already in `deleted` and handled above.
    }
  }

  // ---- Assets owned by deleted docs. ----
  const assets: DeletionAsset[] = [];
  const seenAsset = new Set<string>();
  for (const del of deleted.values()) {
    const record = docByKey.get(docKey(del.typeId, del.enSlug));
    if (!record) continue;
    for (const field of assetFieldsByType.get(del.typeId) ?? []) {
      for (const webPath of assetValuesAt(record.frontmatter, field, del.enSlug)) {
        const dedupeKey = `${del.typeId}\u0000${del.enSlug}\u0000${webPath}`;
        if (seenAsset.has(dedupeKey)) continue;
        seenAsset.add(dedupeKey);
        if (field.assetOnDelete === "keep") {
          assets.push({
            path: webPath,
            ownerTypeId: del.typeId,
            ownerEnSlug: del.enSlug,
            action: "keep",
            reason: "config-keep",
          });
          continue;
        }
        // Delete only when no surviving doc references the same path.
        const refs = assetRefs.get(webPath) ?? new Set<string>();
        let sharedOutside = false;
        for (const owner of refs) {
          if (!deleted.has(owner)) {
            sharedOutside = true;
            break;
          }
        }
        assets.push(
          sharedOutside
            ? {
                path: webPath,
                ownerTypeId: del.typeId,
                ownerEnSlug: del.enSlug,
                action: "keep",
                reason: "shared",
              }
            : {
                path: webPath,
                ownerTypeId: del.typeId,
                ownerEnSlug: del.enSlug,
                action: "delete",
              },
        );
      }
    }
  }

  // ---- Store row counts (best-effort; store may not exist yet). ----
  const store: DeletionStoreCounts[] = [];
  try {
    const db = openStore(project.config, "readonly");
    try {
      for (const del of deleted.values()) {
        store.push({
          typeId: del.typeId,
          enSlug: del.enSlug,
          translations: countTranslationsForEnSlug(db, del.typeId, del.enSlug),
          snapshots: countEnSnapshotsForEnSlug(db, del.typeId, del.enSlug),
        });
      }
    } finally {
      db.close();
    }
  } catch {
    for (const del of deleted.values()) {
      store.push({ typeId: del.typeId, enSlug: del.enSlug, translations: 0, snapshots: 0 });
    }
  }

  const rootTitle = (() => {
    const title = (rootDoc.frontmatter as Record<string, unknown>).title;
    return typeof title === "string" && title.trim() ? title : undefined;
  })();

  const cascades: DeletionCascade[] = [];
  for (const del of deleted.values()) {
    if (del.typeId === typeId && del.enSlug === enSlug) continue;
    cascades.push({ typeId: del.typeId, enSlug: del.enSlug, via: del.via ?? "" });
  }

  // Body references that point INTO the deletion set from a SURVIVING document
  // will dangle. Never block or mutate execution — warn only.
  const bodyRefWarnings = bodyRelationRefs.filter(
    (ref) =>
      deleted.has(docKey(ref.targetTypeId, ref.targetEnSlug)) &&
      !deleted.has(docKey(ref.typeId, ref.enSlug)),
  );

  return {
    roots: [{ typeId, enSlug, title: rootTitle }],
    cascades,
    detaches,
    blocked,
    assets,
    store,
    bodyRefWarnings,
  };
}
