import type { z } from "zod";
import { getAssetMeta, getFieldKind, getRelationTarget, peelOptionalWrappers } from "./field.js";
import type { ContentTypeInput } from "./types.js";

export interface SchemaFieldMeta {
  path: string[];
  kind: "translatable" | "structural" | "relation" | "asset";
  relationTarget?: string;
  relationMultiple?: boolean;
  relationOptional?: boolean;
  assetDir?: string;
  assetTemplate?: string;
  assetFormats?: string[];
  assetMaxKB?: number;
  assetOptional?: boolean;
}

function getArrayElement(schema: z.ZodTypeAny): z.ZodTypeAny | null {
  if (
    schema instanceof Object &&
    "element" in schema &&
    (schema as z.ZodTypeAny & { _def?: { type?: string } })._def?.type === "array"
  ) {
    return (schema as z.ZodArray<z.ZodTypeAny>).element as z.ZodTypeAny;
  }
  return null;
}

/**
 * List schema fields with translatable/structural/relation metadata.
 * Array-of-object fields recurse with a `*` path segment (`steps.*.title`) so
 * extraction and merging preserve the array shape. Note: `peelOptionalWrappers`
 * is used (not `unwrapSchema`) because zod v4 arrays expose `unwrap()`, which
 * would silently flatten the array level out of the paths.
 */
export function introspectSchema(schema: z.ZodTypeAny, prefix: string[] = []): SchemaFieldMeta[] {
  const relation = getRelationTarget(schema);
  if (relation && prefix.length > 0) {
    return [
      {
        path: prefix,
        kind: "relation",
        relationTarget: relation.typeId,
        relationMultiple: relation.multiple,
        relationOptional: relation.optional,
      },
    ];
  }

  const asset = getAssetMeta(schema);
  if (asset && prefix.length > 0) {
    return [
      {
        path: prefix,
        kind: "asset",
        assetDir: asset.dir,
        assetTemplate: asset.template,
        assetFormats: asset.formats,
        assetMaxKB: asset.maxKB,
        assetOptional: asset.optional,
      },
    ];
  }

  // An explicit translatable mark makes the whole subtree one translation unit
  // (e.g. field.translatable(z.array(z.string()))).
  if (prefix.length > 0 && getFieldKind(schema) === "translatable") {
    return [{ path: prefix, kind: "translatable" }];
  }

  const base = peelOptionalWrappers(schema);
  if (base instanceof Object && "shape" in base) {
    const shape = (base as z.ZodObject<z.ZodRawShape>).shape;
    const fields: SchemaFieldMeta[] = [];
    for (const [key, child] of Object.entries(shape)) {
      fields.push(...introspectSchema(child as z.ZodTypeAny, [...prefix, key]));
    }
    return fields;
  }

  const element = getArrayElement(base);
  if (element) {
    const elementBase = peelOptionalWrappers(element);
    if (elementBase instanceof Object && "shape" in elementBase) {
      const shape = (elementBase as z.ZodObject<z.ZodRawShape>).shape;
      const fields: SchemaFieldMeta[] = [];
      for (const [key, child] of Object.entries(shape)) {
        fields.push(...introspectSchema(child as z.ZodTypeAny, [...prefix, "*", key]));
      }
      return fields;
    }
  }

  return [{ path: prefix, kind: getFieldKind(schema) }];
}

interface PathTrie {
  leaf: boolean;
  children: Map<string, PathTrie>;
}

function buildPathTrie(paths: string[][]): PathTrie {
  const root: PathTrie = { leaf: false, children: new Map() };
  for (const path of paths) {
    let node = root;
    for (const segment of path) {
      let child = node.children.get(segment);
      if (!child) {
        child = { leaf: false, children: new Map() };
        node.children.set(segment, child);
      }
      node = child;
    }
    node.leaf = true;
  }
  return root;
}

function extractNode(data: unknown, trie: PathTrie): unknown {
  if (trie.leaf) return data;

  const star = trie.children.get("*");
  if (star) {
    if (!Array.isArray(data)) return undefined;
    // Preserve array length so structural/translatable halves merge per index.
    return data.map((item) =>
      typeof item === "object" && item !== null ? (extractNode(item, star) ?? {}) : {},
    );
  }

  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
  const record = data as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  let any = false;
  for (const [key, child] of trie.children) {
    const value = extractNode(record[key], child);
    if (value !== undefined) {
      out[key] = value;
      any = true;
    }
  }
  return any ? out : undefined;
}

export function extractByPaths(
  data: Record<string, unknown>,
  paths: string[][],
): Record<string, unknown> {
  if (paths.length === 0) return {};
  const extracted = extractNode(data, buildPathTrie(paths));
  return extracted && typeof extracted === "object" && !Array.isArray(extracted)
    ? (extracted as Record<string, unknown>)
    : {};
}

/** Extract frontmatter fields marked as translatable. */
export function pickTranslatable(data: Record<string, unknown>, schema: z.ZodTypeAny): Record<string, unknown> {
  const translatablePaths = introspectSchema(schema)
    .filter((f) => f.kind === "translatable")
    .map((f) => f.path);
  return extractByPaths(data, translatablePaths);
}

/**
 * Drop nested translatable output when the EN document has no matching structural
 * parent (e.g. model-hallucinated blog `itemList` on posts with no ItemList SEO).
 */
export function pruneOrphanNestedTranslations(
  localeData: Record<string, unknown>,
  enData: Record<string, unknown>,
  schema: z.ZodTypeAny,
): Record<string, unknown> {
  const out = { ...localeData };
  const structuralParentsWithNested = new Set<string>();
  for (const meta of introspectSchema(schema)) {
    if (meta.kind !== "translatable" || meta.path.length < 3 || meta.path[1] !== "*") continue;
    structuralParentsWithNested.add(meta.path[0]!);
  }
  for (const parent of structuralParentsWithNested) {
    const enParent = enData[parent];
    if (enParent === undefined || enParent === null) {
      delete out[parent];
    }
  }
  return out;
}

/** Extract frontmatter fields marked as structural (EN-only). */
export function pickStructural(data: Record<string, unknown>, schema: z.ZodTypeAny): Record<string, unknown> {
  const structuralPaths = introspectSchema(schema)
    .filter((f) => f.kind === "structural" || f.kind === "relation" || f.kind === "asset")
    .map((f) => f.path);
  return extractByPaths(data, structuralPaths);
}

/** Merge EN structural fields onto a locale document's frontmatter at load time. */
export function mergeStructuralOntoLocale(
  localeData: Record<string, unknown>,
  enData: Record<string, unknown>,
  schema: z.ZodTypeAny,
): Record<string, unknown> {
  const structural = pickStructural(enData, schema);
  const translatable = pickTranslatable(localeData, schema);
  return deepMerge(structural, translatable);
}

function deepMerge(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      out[key] &&
      typeof out[key] === "object" &&
      !Array.isArray(out[key])
    ) {
      out[key] = deepMerge(out[key] as Record<string, unknown>, value as Record<string, unknown>);
    } else if (Array.isArray(value) && Array.isArray(out[key])) {
      out[key] = mergeArrayOverlay(out[key] as unknown[], value as unknown[]);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

function mergeArrayOverlay(base: unknown[], overlay: unknown[]): unknown[] {
  return base.map((item, index) => {
    const overlayItem = overlay[index];
    if (
      item &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      overlayItem &&
      typeof overlayItem === "object" &&
      !Array.isArray(overlayItem)
    ) {
      return deepMerge(item as Record<string, unknown>, overlayItem as Record<string, unknown>);
    }
    return overlayItem ?? item;
  });
}

/** Collect the schema fields marked `field.translatable()`. */
export function listTranslatableFields(schema: z.ZodTypeAny): SchemaFieldMeta[] {
  return introspectSchema(schema).filter((f) => f.kind === "translatable");
}

/**
 * Whether a content type has anything to translate. A type with a body is
 * always potentially translatable; a bodyless type (`body: false`) is
 * translatable only when at least one schema field is `field.translatable()`.
 *
 * The single source of truth for every translation workflow (worklist, staleness,
 * status counts, studio dashboards, store writes): a type for which this returns
 * `false` disappears from all of them.
 */
export function isTypeTranslatable(type: Pick<ContentTypeInput, "schema" | "body">): boolean {
  return listTranslatableFields(type.schema).length > 0 || type.body !== false;
}

/** Collect relation field paths and targets from a content schema. */
export function listRelationFields(schema: z.ZodTypeAny): SchemaFieldMeta[] {
  return introspectSchema(schema).filter((f) => f.kind === "relation");
}

/** Collect asset field paths and constraints from a content schema. */
export function listAssetFields(schema: z.ZodTypeAny): SchemaFieldMeta[] {
  return introspectSchema(schema).filter((f) => f.kind === "asset");
}
