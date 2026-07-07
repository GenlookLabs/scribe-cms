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

/** Return whether a Zod field is translatable or structural. */
export function getFieldKind(schema: Zod.ZodTypeAny): FieldKind {
  const tagged = schema as Zod.ZodTypeAny & { [FIELD_KIND]?: FieldKind };
  return tagged[FIELD_KIND] ?? "structural";
}

/** Return relation metadata if the field was created with `field.relation()`. */
export function getRelationTarget(schema: Zod.ZodTypeAny): RelationMeta | null {
  let current: Zod.ZodTypeAny = schema;
  for (let i = 0; i < 8; i++) {
    const tagged = current as Zod.ZodTypeAny & {
      [RELATION_META]?: RelationMeta;
      unwrap?: () => Zod.ZodTypeAny;
      removeDefault?: () => Zod.ZodTypeAny;
      _def?: { innerType?: Zod.ZodTypeAny };
    };
    if (tagged[RELATION_META]) {
      return tagged[RELATION_META];
    }
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
    const tagged = current as Zod.ZodTypeAny & {
      [ASSET_META]?: AssetMeta;
      unwrap?: () => Zod.ZodTypeAny;
      removeDefault?: () => Zod.ZodTypeAny;
      _def?: { innerType?: Zod.ZodTypeAny };
    };
    if (tagged[ASSET_META]) {
      return tagged[ASSET_META];
    }
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

function mark<T extends Zod.ZodTypeAny>(schema: T, kind: FieldKind): T {
  Object.defineProperty(schema, FIELD_KIND, {
    value: kind,
    enumerable: false,
    configurable: true,
  });
  return schema;
}

function markRelation<T extends Zod.ZodTypeAny>(schema: T, meta: RelationMeta): T {
  Object.defineProperty(schema, RELATION_META, {
    value: meta,
    enumerable: false,
    configurable: true,
  });
  return mark(schema, "structural");
}

function markAsset<T extends Zod.ZodTypeAny>(schema: T, meta: AssetMeta): T {
  Object.defineProperty(schema, ASSET_META, {
    value: meta,
    enumerable: false,
    configurable: true,
  });
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
 */
export interface AssetFieldOptions {
  /** Web-path prefix the value must live under (e.g. `"/try-on/garments"`). Also declares a managed root. */
  dir?: string;
  /**
   * Derived-path template, e.g. `"/try-on/garments/{slug}/product.webp"` —
   * `{slug}` is the entry's EN slug. When set, the frontmatter field may be
   * omitted entirely; the loader fills it. An explicit frontmatter value
   * overrides the template. Its static prefix counts as a managed root.
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
}

type Bool<T> = [T] extends [true] ? true : false;

/**
 * Zod shape of a `field.asset()` schema: optional only when `optional` is set.
 *
 * A non-optional `template` field types as `ZodString` even though the runtime
 * schema tolerates an absent frontmatter value: the loader materializes the
 * templated path onto every document it serves (`resolveDocumentAssets` runs on
 * both EN and locale docs), so consumers always observe a `string`.
 */
export type AssetField<TOpts extends AssetFieldOptions = AssetFieldOptions> =
  Bool<TOpts["optional"]> extends true ? Zod.ZodOptional<Zod.ZodString> : Zod.ZodString;

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
    const inner = z.string().min(1);
    markAsset(inner, {
      dir: options?.dir,
      template: options?.template,
      formats: options?.formats,
      maxKB: options?.maxKB,
      optional,
      onDelete: options?.onDelete ?? "delete",
    });
    // A templated field may be omitted in frontmatter — the loader materializes it.
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
      current = (current as Zod.ZodDefault<Zod.ZodTypeAny>).removeDefault();
      continue;
    }
    break;
  }
  return current;
}
