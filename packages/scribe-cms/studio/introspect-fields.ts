import type { z } from "zod";
import { peelOptionalWrappers } from "../src/core/field.js";
import {
  introspectSchema,
  listAssetFields,
  listRelationFields,
  type SchemaFieldMeta,
} from "../src/core/introspect-schema.js";
import { collectImagePaths } from "../src/validate/validate-assets.js";
import { walkAssetValues } from "../src/core/walk-asset-values.js";
import { extractInlineTokens } from "../src/inline/tokens.js";
import type { ContentTypeRuntime, ScribeDocument } from "../src/core/types.js";

/**
 * Studio-only schema introspection: extends the core `SchemaFieldMeta` with the
 * bits the read-only browser needs — enum options and a scalar/filterable
 * classification — none of which the loader/validator require. Kept generic:
 * everything is derived from the zod schema, never from a content-type id.
 */

export type FilterKind = "enum" | "relation" | "boolean" | "string";

export interface StudioFieldMeta extends SchemaFieldMeta {
  /** Enum options, when the peeled leaf schema is a `z.enum`. */
  enumOptions?: string[];
  /** True when the peeled leaf schema is a boolean. */
  isBoolean?: boolean;
  /** True when the field is a single-value scalar (string/number/enum/boolean, not array/object). */
  isScalar?: boolean;
}

/** Walk a schema path to its leaf zod node so we can read enum options / boolean-ness. */
function leafSchemaAtPath(schema: z.ZodTypeAny, path: string[]): z.ZodTypeAny | null {
  let current: z.ZodTypeAny | null = peelOptionalWrappers(schema);
  for (const segment of path) {
    if (!current) return null;
    if (segment === "*") {
      const def = (current as z.ZodTypeAny & { _def?: { type?: string } })._def;
      if (def?.type === "array") {
        current = peelOptionalWrappers((current as z.ZodArray<z.ZodTypeAny>).element);
        continue;
      }
      return null;
    }
    if (current instanceof Object && "shape" in current) {
      const shape = (current as z.ZodObject<z.ZodRawShape>).shape;
      const child = shape[segment] as z.ZodTypeAny | undefined;
      if (!child) return null;
      current = peelOptionalWrappers(child);
      continue;
    }
    return null;
  }
  return current;
}

function enumOptionsOf(leaf: z.ZodTypeAny): string[] | undefined {
  const withOptions = leaf as z.ZodTypeAny & { options?: unknown; _def?: { type?: string } };
  if (withOptions._def?.type !== "enum") return undefined;
  const options = withOptions.options;
  if (Array.isArray(options) && options.every((o) => typeof o === "string")) {
    return options as string[];
  }
  return undefined;
}

function leafTypeName(leaf: z.ZodTypeAny): string | undefined {
  return (leaf as z.ZodTypeAny & { _def?: { type?: string } })._def?.type;
}

/** Introspect a content schema for the studio: field kinds plus enum/boolean/scalar hints. */
export function introspectStudioFields(schema: z.ZodTypeAny): StudioFieldMeta[] {
  return introspectSchema(schema).map((field) => {
    const leaf = leafSchemaAtPath(schema, field.path);
    const meta: StudioFieldMeta = { ...field };
    if (leaf) {
      const enumOptions = enumOptionsOf(leaf);
      if (enumOptions) meta.enumOptions = enumOptions;
      const typeName = leafTypeName(leaf);
      meta.isBoolean = typeName === "boolean";
      meta.isScalar =
        typeName === "string" ||
        typeName === "number" ||
        typeName === "enum" ||
        typeName === "boolean";
    }
    return meta;
  });
}

export interface FilterFieldMeta {
  /** Dotted field path (top-level only; no `*` segments). */
  key: string;
  kind: FilterKind;
  /** Enum options for `kind === "enum"`. */
  enumOptions?: string[];
  /** Relation target type id for `kind === "relation"`. */
  relationTarget?: string;
  /** Field's `.describe()` help text, surfaced as the filter label's `title`. */
  description?: string;
}

/**
 * Filterable fields for a type's collection browser: top-level enum, relation,
 * boolean and string fields (no nested `*` array fields — those don't map onto a
 * single query param cleanly). Order follows schema declaration order.
 */
export function filterFieldsFor(schema: z.ZodTypeAny): FilterFieldMeta[] {
  const out: FilterFieldMeta[] = [];
  for (const field of introspectStudioFields(schema)) {
    if (field.path.length !== 1 || field.path.includes("*")) continue;
    const key = field.path[0]!;
    const description = field.description;
    if (field.kind === "relation") {
      out.push({ key, kind: "relation", relationTarget: field.relationTarget, description });
    } else if (field.enumOptions) {
      out.push({ key, kind: "enum", enumOptions: field.enumOptions, description });
    } else if (field.isBoolean) {
      out.push({ key, kind: "boolean", description });
    } else if (field.kind !== "asset" && field.isScalar) {
      out.push({ key, kind: "string", description });
    }
  }
  return out;
}

/**
 * Key fields to preview in the entry table (first few scalar/enum/relation
 * top-level fields, excluding assets which get their own gallery treatment).
 * Generic: picks by kind, never by field name.
 */
export function keyFieldsFor(schema: z.ZodTypeAny, limit = 4): StudioFieldMeta[] {
  const out: StudioFieldMeta[] = [];
  for (const field of introspectStudioFields(schema)) {
    if (field.path.length !== 1 || field.path.includes("*")) continue;
    if (field.kind === "asset") continue;
    const isEnumOrRelation = field.kind === "relation" || Boolean(field.enumOptions);
    if (isEnumOrRelation || field.isScalar || field.kind === "translatable") {
      out.push(field);
    }
    if (out.length >= limit) break;
  }
  return out;
}

/** First top-level asset field of a type, if any (the gallery's primary image). */
export function primaryAssetField(schema: z.ZodTypeAny): SchemaFieldMeta | undefined {
  return listAssetFields(schema).find((f) => !f.path.includes("*")) ?? listAssetFields(schema)[0];
}

/** Read a frontmatter value at a dotted/`*` path (top-level flat use only). */
export function valueAtPath(
  frontmatter: Record<string, unknown>,
  path: string[],
): unknown {
  let current: unknown = frontmatter;
  for (const segment of path) {
    if (segment === "*") return current; // arrays: return the array itself
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

// ---------------------------------------------------------------------------
// Back-reference index (relations)
// ---------------------------------------------------------------------------

export interface BackRef {
  /** Type id of the referring entry. */
  typeId: string;
  /** EN slug of the referring entry. */
  enSlug: string;
  /** Dotted relation field path on the referring entry. */
  field: string;
}

/** `targetTypeId` → `targetEnSlug` → list of entries referencing it. */
export type BackRefIndex = Map<string, Map<string, BackRef[]>>;

function pushBackRef(index: BackRefIndex, targetType: string, targetSlug: string, ref: BackRef): void {
  let byType = index.get(targetType);
  if (!byType) {
    byType = new Map();
    index.set(targetType, byType);
  }
  const list = byType.get(targetSlug) ?? [];
  list.push(ref);
  byType.set(targetSlug, list);
}

interface RelationScanInput {
  typeId: string;
  enSlug: string;
  frontmatter: Record<string, unknown>;
  relationFields: SchemaFieldMeta[];
  /** MDX body, scanned for `${{relation:...}}` inline tokens. */
  body?: string;
}

/**
 * Build a reverse-reference index over every relation field of every EN entry:
 * "which entries point at (targetType, targetSlug)?". Pure over the provided
 * document snapshots — no filesystem access — so it's unit-testable.
 */
export function buildBackRefIndex(inputs: RelationScanInput[]): BackRefIndex {
  const index: BackRefIndex = new Map();
  for (const input of inputs) {
    for (const field of input.relationFields) {
      const target = field.relationTarget;
      if (!target) continue;
      const value = valueAtPath(input.frontmatter, field.path);
      const ref: BackRef = { typeId: input.typeId, enSlug: input.enSlug, field: field.path.join(".") };
      if (field.relationMultiple) {
        if (!Array.isArray(value)) continue;
        for (const slug of value) {
          if (typeof slug === "string" && slug) pushBackRef(index, target, slug, ref);
        }
      } else if (typeof value === "string" && value) {
        pushBackRef(index, target, value, ref);
      }
    }

    // Body relation tokens (`${{relation:type:slug}}`, both URL and slug modes)
    // register as back-refs with a `body` field label.
    if (input.body) {
      for (const token of extractInlineTokens(input.body).tokens) {
        if (token.kind !== "relation") continue;
        pushBackRef(index, token.targetTypeId, token.enSlug, {
          typeId: input.typeId,
          enSlug: input.enSlug,
          field: "body",
        });
      }
    }
  }
  return index;
}

/** Look up entries referencing a target entry via any relation field. */
export function backRefsFor(index: BackRefIndex, targetType: string, targetSlug: string): BackRef[] {
  return index.get(targetType)?.get(targetSlug) ?? [];
}

// ---------------------------------------------------------------------------
// Asset reference graph
// ---------------------------------------------------------------------------

export interface AssetRef {
  typeId: string;
  enSlug: string;
  /** Dotted field path, or `"body"`/`"frontmatter"` for heuristic matches. */
  field: string;
  /** True when the reference comes from a declared `field.asset()` (carries constraints). */
  declared: boolean;
  /** Declared field's `maxKB`, when known. */
  maxKB?: number;
  /** Declared field's allowed `formats`, when known. */
  formats?: string[];
}

/** web path (source, unresolved) → list of references. */
export type AssetRefIndex = Map<string, AssetRef[]>;

interface AssetScanInput {
  typeId: string;
  enSlug: string;
  /** SOURCE (unresolved) frontmatter — declared asset values are raw web paths. */
  frontmatter: Record<string, unknown>;
  body: string;
  assetFields: SchemaFieldMeta[];
}

function pushAssetRef(index: AssetRefIndex, webPath: string, ref: AssetRef): void {
  const list = index.get(webPath) ?? [];
  list.push(ref);
  index.set(webPath, list);
}

/** Collect each concrete declared-asset value (materializing templates) from source frontmatter. */
function collectDeclaredValues(
  frontmatter: Record<string, unknown>,
  enSlug: string,
  field: SchemaFieldMeta,
): Array<{ value: string; fieldPath: string }> {
  const out: Array<{ value: string; fieldPath: string }> = [];
  walkAssetValues(
    frontmatter,
    field.path,
    ({ raw, fieldPath }) => {
      if (typeof raw === "string" && raw) out.push({ value: raw, fieldPath });
      else if (raw === undefined && field.assetTemplate) {
        out.push({ value: field.assetTemplate.split("{slug}").join(enSlug), fieldPath });
      }
    },
    { multiple: field.assetMultiple },
  );
  return out;
}

/**
 * Build the asset reference graph: every declared asset-field value (all types)
 * plus the heuristic `collectImagePaths` over frontmatter + MDX bodies. Keyed by
 * source web path. Pure over the provided snapshots — unit-testable.
 */
export function buildAssetRefIndex(inputs: AssetScanInput[]): AssetRefIndex {
  const index: AssetRefIndex = new Map();
  for (const input of inputs) {
    const declaredPaths = new Set<string>();
    for (const field of input.assetFields) {
      for (const { value, fieldPath } of collectDeclaredValues(input.frontmatter, input.enSlug, field)) {
        declaredPaths.add(value);
        pushAssetRef(index, value, {
          typeId: input.typeId,
          enSlug: input.enSlug,
          field: fieldPath,
          declared: true,
          maxKB: field.assetMaxKB,
          formats: field.assetFormats,
        });
      }
    }
    // Body asset tokens (`${{asset:/path}}`) are declared references — they name
    // an exact web path, unlike the heuristic image-path scan below.
    for (const token of extractInlineTokens(input.body).tokens) {
      if (token.kind !== "asset") continue;
      declaredPaths.add(token.webPath);
      pushAssetRef(index, token.webPath, {
        typeId: input.typeId,
        enSlug: input.enSlug,
        field: "body",
        declared: true,
      });
    }
    // Heuristic pass (body + frontmatter image-looking strings). Skip paths
    // already captured as declared to avoid double reporting the same file.
    for (const webPath of collectImagePaths(input.frontmatter, input.body)) {
      if (declaredPaths.has(webPath)) continue;
      pushAssetRef(index, webPath, {
        typeId: input.typeId,
        enSlug: input.enSlug,
        field: "body/frontmatter",
        declared: false,
      });
    }
  }
  return index;
}

// ---------------------------------------------------------------------------
// Snapshot builders (filesystem-backed) — thin adapters over runtimes
// ---------------------------------------------------------------------------

/**
 * Read EN docs of every type and build both indexes. Uses the *source*
 * (unresolved) frontmatter — the studio builds its own preview URLs and never
 * relies on site-resolved asset URLs. Runtimes here come from `createProject()`
 * WITHOUT `resolveAssets`, so `frontmatter` already holds source values.
 */
export function buildIndexes(types: ContentTypeRuntime[]): {
  backRefs: BackRefIndex;
  assetRefs: AssetRefIndex;
} {
  const relationInputs: RelationScanInput[] = [];
  const assetInputs: AssetScanInput[] = [];
  for (const type of types) {
    const relationFields = listRelationFields(type.config.schema);
    const assetFields = listAssetFields(type.config.schema);
    const docs = type.list() as ScribeDocument[];
    for (const doc of docs) {
      const frontmatter = doc.frontmatter as Record<string, unknown>;
      // Push for every doc (not only those with relation fields): a body may
      // hold `${{relation:...}}` tokens even when the schema declares none.
      relationInputs.push({
        typeId: type.id,
        enSlug: doc.enSlug,
        frontmatter,
        relationFields,
        body: doc.content,
      });
      assetInputs.push({
        typeId: type.id,
        enSlug: doc.enSlug,
        frontmatter,
        body: doc.content,
        assetFields,
      });
    }
  }
  return {
    backRefs: buildBackRefIndex(relationInputs),
    assetRefs: buildAssetRefIndex(assetInputs),
  };
}
