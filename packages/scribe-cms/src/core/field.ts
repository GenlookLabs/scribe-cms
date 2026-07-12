import { z } from "zod";
import type { z as Zod } from "zod";

const FIELD_KIND = Symbol.for("@genlook/scribe/fieldKind");
const RELATION_META = Symbol.for("@genlook/scribe/relationMeta");
const ASSET_META = Symbol.for("@genlook/scribe/assetMeta");

export type FieldKind = "translatable" | "structural";

/**
 * What happens to a document that references a target when that target is
 * deleted (see `docs/deletion.md`).
 * - `"restrict"` (default) — deletion of the target is blocked.
 * - `"detach"` — the reference is removed (dropped from arrays, optional single
 *   relations cleared). A required single relation can never be detached.
 * - `"cascade"` — the referencing document is deleted too, recursively.
 */
export type OnTargetDelete = "restrict" | "detach" | "cascade";

/** What happens to an asset file when its own document is deleted. Default `"delete"`. */
export type AssetOnDelete = "delete" | "keep";

export interface RelationMeta {
  typeId: string;
  multiple: boolean;
  optional: boolean;
  /** Cascade behavior applied when the referenced target is deleted. */
  onTargetDelete: OnTargetDelete;
}

/** Constraints carried by a `field.asset()` schema (see `docs/assets.md`). */
export interface AssetMeta {
  dir?: string;
  template?: string;
  formats?: string[];
  maxKB?: number;
  optional: boolean;
  /** Whether the file is removed when its document is deleted. Default `"delete"`. */
  onDelete: AssetOnDelete;
  /** Field holds an array of web paths (`{ multiple: true }`) instead of a single path. */
  multiple: boolean;
  /** Minimum item count (`multiple: true` only). */
  min?: number;
  /** Maximum item count (`multiple: true` only). */
  max?: number;
}

/**
 * Type-level brand carried by `field.relation()` schemas so the target
 * content-type id (and multiplicity/optionality) survive into `related()`.
 * Never exists at runtime.
 */
export declare const RELATION_BRAND: unique symbol;

export interface RelationBrand<
  TTarget extends string = string,
  TMultiple extends boolean = boolean,
  TOptional extends boolean = boolean,
> {
  target: TTarget;
  multiple: TMultiple;
  optional: TOptional;
}

/** A Zod schema branded with relation metadata (see `field.relation()`). */
export type RelationField<
  TZod extends Zod.ZodTypeAny,
  TBrand extends RelationBrand,
> = TZod & { [RELATION_BRAND]: TBrand };

/**
 * Attach a non-enumerable brand to a schema. We define it on BOTH the schema
 * instance AND its `_def`, because `.describe()` (and `.meta()`) return a CLONE
 * that shares the same `_def` object reference but drops instance-only symbol
 * properties. Branding `_def` too is what lets `field.asset(...).describe("…")`
 * survive brand detection even for a non-optional field (where the branded
 * schema IS the leaf that `.describe()` clones). See `docs/assets.md`.
 */
function defineBrand(schema: Zod.ZodTypeAny, sym: symbol, value: unknown): void {
  Object.defineProperty(schema, sym, { value, enumerable: false, configurable: true });
  const def = (schema as { _def?: object })._def;
  if (def && typeof def === "object") {
    Object.defineProperty(def, sym, { value, enumerable: false, configurable: true });
  }
}

/** Read a brand from a schema instance, falling back to its `_def` (see `defineBrand`). */
function readBrand<V>(schema: Zod.ZodTypeAny, sym: symbol): V | undefined {
  const anySchema = schema as unknown as { [k: symbol]: unknown; _def?: { [k: symbol]: unknown } };
  const direct = anySchema[sym];
  if (direct !== undefined) return direct as V;
  const def = anySchema._def;
  return def ? (def[sym] as V | undefined) : undefined;
}

/** Return whether a Zod field is translatable or structural. */
export function getFieldKind(schema: Zod.ZodTypeAny): FieldKind {
  return readBrand<FieldKind>(schema, FIELD_KIND) ?? "structural";
}

/** Return relation metadata if the field was created with `field.relation()`. */
export function getRelationTarget(schema: Zod.ZodTypeAny): RelationMeta | null {
  let current: Zod.ZodTypeAny = schema;
  for (let i = 0; i < 8; i++) {
    const meta = readBrand<RelationMeta>(current, RELATION_META);
    if (meta) return meta;
    const tagged = current as Zod.ZodTypeAny & {
      unwrap?: () => Zod.ZodTypeAny;
      removeDefault?: () => Zod.ZodTypeAny;
      _def?: { innerType?: Zod.ZodTypeAny };
    };
    if (typeof tagged.unwrap === "function") {
      current = tagged.unwrap();
      continue;
    }
    if (typeof tagged.removeDefault === "function") {
      current = tagged.removeDefault();
      continue;
    }
    if (tagged._def?.innerType) {
      current = tagged._def.innerType;
      continue;
    }
    break;
  }
  return null;
}

/** Return asset metadata if the field was created with `field.asset()`. */
export function getAssetMeta(schema: Zod.ZodTypeAny): AssetMeta | null {
  let current: Zod.ZodTypeAny = schema;
  for (let i = 0; i < 8; i++) {
    const meta = readBrand<AssetMeta>(current, ASSET_META);
    if (meta) return meta;
    const tagged = current as Zod.ZodTypeAny & {
      unwrap?: () => Zod.ZodTypeAny;
      removeDefault?: () => Zod.ZodTypeAny;
      _def?: { innerType?: Zod.ZodTypeAny };
    };
    if (typeof tagged.unwrap === "function") {
      current = tagged.unwrap();
      continue;
    }
    if (typeof tagged.removeDefault === "function") {
      current = tagged.removeDefault();
      continue;
    }
    if (tagged._def?.innerType) {
      current = tagged._def.innerType;
      continue;
    }
    break;
  }
  return null;
}

/**
 * Read the human-readable description attached with Zod's native `.describe()`.
 * The description may sit on the outer wrapper (`z.string().optional().describe()`)
 * OR the inner schema (`z.string().describe().optional()`) — walk wrappers
 * outer-to-inner and return the first one found (outer wins). Returns `undefined`
 * when no description was set. See `docs/configuration.md` (field descriptions).
 */
export function getFieldDescription(schema: Zod.ZodTypeAny): string | undefined {
  let current: Zod.ZodTypeAny = schema;
  for (let i = 0; i < 8; i++) {
    const desc = (current as Zod.ZodTypeAny & { description?: unknown }).description;
    if (typeof desc === "string" && desc.length > 0) return desc;
    const anySchema = current as Zod.ZodTypeAny & {
      unwrap?: () => Zod.ZodTypeAny;
      removeDefault?: () => Zod.ZodTypeAny;
      _def?: { innerType?: Zod.ZodTypeAny };
    };
    if (typeof anySchema.unwrap === "function") {
      current = anySchema.unwrap();
      continue;
    }
    if (typeof anySchema.removeDefault === "function") {
      current = anySchema.removeDefault();
      continue;
    }
    if (anySchema._def?.innerType) {
      current = anySchema._def.innerType;
      continue;
    }
    break;
  }
  return undefined;
}

function mark<T extends Zod.ZodTypeAny>(schema: T, kind: FieldKind): T {
  defineBrand(schema, FIELD_KIND, kind);
  return schema;
}

function markRelation<T extends Zod.ZodTypeAny>(schema: T, meta: RelationMeta): T {
  defineBrand(schema, RELATION_META, meta);
  return mark(schema, "structural");
}

function markAsset<T extends Zod.ZodTypeAny>(schema: T, meta: AssetMeta): T {
  defineBrand(schema, ASSET_META, meta);
  return mark(schema, "structural");
}

/**
 * Options for `field.relation()`. Constraints live here (not as chained Zod
 * methods) because chaining clones the schema and would drop the relation
 * metadata.
 */
export interface RelationFieldOptions {
  /** The field holds an array of slugs instead of a single slug. */
  multiple?: boolean;
  /** The field may be omitted; `related()` then returns `null` (single) or `[]` (multiple). */
  optional?: boolean;
  /** Minimum item count (`multiple: true` only). */
  min?: number;
  /** Maximum item count (`multiple: true` only). */
  max?: number;
  /**
   * What happens to THIS document when the referenced target is deleted:
   * `"restrict"` (default), `"detach"`, or `"cascade"`. See `docs/deletion.md`.
   */
  onTargetDelete?: OnTargetDelete;
}

/**
 * Options for `field.asset()`. Constraints live here (not as chained Zod
 * methods) because chaining clones the schema and would drop the asset
 * metadata. See `docs/assets.md` for the full design.
 *
 * A "multiple" field (`{ multiple: true }`) holds an **array** of web paths.
 * This is the supported API for many-assets — NOT `z.array(field.asset())`,
 * which mis-detects: `getAssetMeta` unwraps arrays, so it would read the inner
 * single-asset brand and treat the array as one path.
 */
export interface AssetFieldOptions {
  /** Web-path prefix the value must live under (e.g. `"/try-on/garments"`). Also declares a managed root. */
  dir?: string;
  /**
   * Derived-path template, e.g. `"/try-on/garments/{slug}/product.webp"` —
   * `{slug}` is the entry's EN slug. When set, the frontmatter field may be
   * omitted entirely; the loader fills it. An explicit frontmatter value
   * overrides the template. Its static prefix counts as a managed root.
   * Cannot be combined with `multiple` (a template materializes one `{slug}`
   * path; a multiple field carries explicit paths).
   */
  template?: string;
  /** Allowed extensions (lowercase, no dot). Violation = validation warning. */
  formats?: string[];
  /** File-size budget in kilobytes. Violation = validation warning. */
  maxKB?: number;
  /** The field may be absent (only meaningful without `template`). A present value whose file is missing is still an error. */
  optional?: boolean;
  /**
   * What happens to the file when its own document is deleted: `"delete"`
   * (default) or `"keep"`. A shared (non-templated) path is only removed when no
   * document outside the deletion set still references it. See `docs/deletion.md`.
   */
  onDelete?: AssetOnDelete;
  /** The field holds an array of web paths instead of a single one. Mirrors `field.relation`'s multi support. */
  multiple?: boolean;
  /** Minimum item count (`multiple: true` only). */
  min?: number;
  /** Maximum item count (`multiple: true` only). */
  max?: number;
}

type Bool<T> = [T] extends [true] ? true : false;

/**
 * Zod shape of a `field.asset()` schema: an array of strings when
 * `{ multiple: true }`, otherwise a single string; wrapped in `ZodOptional`
 * only when `optional` is set.
 *
 * A non-optional single `template` field types as `ZodString` even though the
 * runtime schema tolerates an absent frontmatter value: the loader materializes
 * the templated path onto every document it serves (`resolveDocumentAssets`
 * runs on both EN and locale docs), so consumers always observe a `string`.
 * A `multiple` field always observes a `string[]` (each element already
 * prefixed with `publicPath`); it has no template.
 */
export type AssetField<TOpts extends AssetFieldOptions = AssetFieldOptions> =
  Bool<TOpts["optional"]> extends true
    ? Zod.ZodOptional<
        Bool<TOpts["multiple"]> extends true ? Zod.ZodArray<Zod.ZodString> : Zod.ZodString
      >
    : Bool<TOpts["multiple"]> extends true
      ? Zod.ZodArray<Zod.ZodString>
      : Zod.ZodString;

type RelationZod<TOpts extends RelationFieldOptions> =
  Bool<TOpts["optional"]> extends true
    ? Zod.ZodOptional<
        Bool<TOpts["multiple"]> extends true ? Zod.ZodArray<Zod.ZodString> : Zod.ZodString
      >
    : Bool<TOpts["multiple"]> extends true
      ? Zod.ZodArray<Zod.ZodString>
      : Zod.ZodString;

type RelationFieldFor<
  TTarget extends string,
  TOpts extends RelationFieldOptions,
> = RelationField<
  RelationZod<TOpts>,
  RelationBrand<TTarget, Bool<TOpts["multiple"]>, Bool<TOpts["optional"]>>
>;

/**
 * Mark Zod fields for Scribe:
 * - `translatable(schema)` — sent to the translator per locale.
 * - `structural(schema)` — EN-only; merged from EN into every locale document.
 * - `relation(typeId, options?)` — EN slug reference(s) to another content type,
 *   validated by `scribe validate` and dereferenced via `scribe.<type>.related()`.
 * - `asset(options?)` — root-relative web path to a file under `assets.dir`,
 *   validated by `scribe validate` and resolved to a served URL at load time.
 */
export const field = {
  translatable: <T extends Zod.ZodTypeAny>(schema: T): T => mark(schema, "translatable"),
  structural: <T extends Zod.ZodTypeAny>(schema: T): T => mark(schema, "structural"),
  relation: <const TTarget extends string, const TOpts extends RelationFieldOptions = {}>(
    typeId: TTarget,
    options?: TOpts,
  ): RelationFieldFor<TTarget, TOpts> => {
    const multiple = options?.multiple ?? false;
    const optional = options?.optional ?? false;
    if ((options?.min !== undefined || options?.max !== undefined) && !multiple) {
      throw new Error(
        `field.relation("${typeId}"): min/max require { multiple: true }`,
      );
    }
    let inner: Zod.ZodTypeAny;
    if (multiple) {
      let arr = z.array(z.string().min(1));
      if (options?.min !== undefined) arr = arr.min(options.min);
      if (options?.max !== undefined) arr = arr.max(options.max);
      inner = arr;
    } else {
      inner = z.string().min(1);
    }
    const onTargetDelete = options?.onTargetDelete ?? "restrict";
    markRelation(inner, { typeId, multiple, optional, onTargetDelete });
    const schema = optional ? inner.optional() : inner;
    return schema as RelationFieldFor<TTarget, TOpts>;
  },
  asset: <const TOpts extends AssetFieldOptions = {}>(options?: TOpts): AssetField<TOpts> => {
    const optional = options?.optional ?? false;
    const multiple = options?.multiple ?? false;
    if (multiple && options?.template !== undefined) {
      throw new Error(
        "field.asset: { multiple: true } cannot be combined with a template — a template " +
          "materializes one {slug} path, but a multiple field carries explicit paths in frontmatter.",
      );
    }
    if ((options?.min !== undefined || options?.max !== undefined) && !multiple) {
      throw new Error("field.asset: min/max require { multiple: true }");
    }
    const meta: AssetMeta = {
      dir: options?.dir,
      template: options?.template,
      formats: options?.formats,
      maxKB: options?.maxKB,
      optional,
      onDelete: options?.onDelete ?? "delete",
      multiple,
    };
    if (options?.min !== undefined) meta.min = options.min;
    if (options?.max !== undefined) meta.max = options.max;

    let inner: Zod.ZodTypeAny;
    if (multiple) {
      let arr = z.array(z.string().min(1));
      if (options?.min !== undefined) arr = arr.min(options.min);
      if (options?.max !== undefined) arr = arr.max(options.max);
      inner = arr;
    } else {
      inner = z.string().min(1);
    }
    markAsset(inner, meta);
    // A templated single field may be omitted in frontmatter — the loader materializes it.
    const schema = optional || options?.template !== undefined ? inner.optional() : inner;
    return schema as AssetField<TOpts>;
  },
};

/** Strip Zod wrappers (optional, default, etc.) to reach the inner schema. */
export function unwrapSchema(schema: Zod.ZodTypeAny): Zod.ZodTypeAny {
  let current: Zod.ZodTypeAny = schema;
  for (let i = 0; i < 8; i++) {
    const anySchema = current as Zod.ZodTypeAny & {
      unwrap?: () => Zod.ZodTypeAny;
      removeDefault?: () => Zod.ZodTypeAny;
      _def?: { innerType?: Zod.ZodTypeAny; type?: string };
    };
    if (typeof anySchema.unwrap === "function") {
      current = anySchema.unwrap();
      continue;
    }
    if (typeof anySchema.removeDefault === "function") {
      current = anySchema.removeDefault();
      continue;
    }
    if (anySchema._def?.innerType) {
      current = anySchema._def.innerType;
      continue;
    }
    break;
  }
  return current;
}

/** Strip optional/default/nullable wrappers only — preserves arrays and objects. */
export function peelOptionalWrappers(schema: Zod.ZodTypeAny): Zod.ZodTypeAny {
  let current: Zod.ZodTypeAny = schema;
  for (let i = 0; i < 8; i++) {
    const type = (current as Zod.ZodTypeAny & { _def?: { type?: string } })._def?.type;
    if (type === "optional" || type === "nullable") {
      current = (current as Zod.ZodOptional<Zod.ZodTypeAny>).unwrap();
      continue;
    }
    if (type === "default") {
      current = (current as Zod.ZodDefault<Zod.ZodTypeAny>).unwrap() as Zod.ZodTypeAny;
      continue;
    }
    break;
  }
  return current;
}
