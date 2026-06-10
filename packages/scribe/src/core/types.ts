import type { z } from "zod";
import type { RELATION_BRAND, RelationBrand } from "./field.js";

/**
 * How document slugs behave across locales.
 * - `"fixed"` — the EN slug is used for every locale.
 * - `"localized"` — each locale gets its own translated slug.
 */
export type SlugStrategy = "localized" | "fixed";

/**
 * What `resolve()` returns when a locale has no translation for a slug.
 * - `"en"` — fall back to the default-locale document.
 * - `"none"` — return no document.
 */
export type IndexFallback = "en" | "none";

/** Sort order for `list()`. Built-in keys sort by document metadata; pass a comparator for anything else. */
export type OrderBy<TDoc = ScribeDocument> =
  | "slug"
  | "publishedAt"
  | "-publishedAt"
  | "updatedAt"
  | "-updatedAt"
  | ((a: TDoc, b: TDoc) => number);

export interface CrossValidateContext {
  locale: string;
  defaultLocale: string;
  slug: string;
  enSlug: string;
  knownLocales: readonly string[];
  englishSlugs?: ReadonlySet<string>;
}

export interface CrossValidateIssue {
  field: string;
  message: string;
  level: "error" | "warning";
}

/** Named locale groups usable with `scribe translate --preset <name>`. */
export interface LocalePresets {
  active?: string[];
  ultraLight?: string[];
  [name: string]: string[] | undefined;
}

/** Per-content-type translation settings (merged over the project-level defaults). */
export interface TranslateConfig {
  /** Replace the default system prompt entirely. */
  prompt?: string;
  /** Brand/domain context prepended to every translation request. */
  context?: string;
  /** Extra rules appended to the default rules. */
  rules?: string[];
  /** Model override for this content type. */
  model?: string;
}

/** Project-level translation defaults. */
export interface ScribeTranslateDefaults {
  defaultModel?: string;
  prompt?: string;
  context?: string;
  rules?: string[];
  /** Lowercase terms preserved verbatim in localized slugs */
  slugPreserveTerms?: string[];
}

/**
 * A content type declaration as written in `scribe.config.ts`.
 * Most fields are optional with sensible defaults — see each field's doc.
 */
export interface ContentTypeInput<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  /** Unique id. Becomes the typed accessor (`scribe.<id>`) and the default `contentDir`. */
  id: string;
  /** Zod schema for the EN frontmatter. Mark fields with `field.translatable()/structural()/relation()`. */
  schema: TSchema;
  /** Directory under the project content dir holding this type's `.mdx` files. Default: the type `id`. */
  contentDir?: string;
  /** URL template for routable types, e.g. `/blog/{slug}`. Must contain exactly one `{slug}`. Omit for reference-only types. */
  path?: string;
  /** Human label (studio UI). Default: capitalized `id`. */
  label?: string;
  /** Default: `"fixed"`. */
  slugStrategy?: SlugStrategy;
  /** Default: `"en"` when the type has a `path`, otherwise `"none"`. */
  indexFallback?: IndexFallback;
  /** Default sort for `list()`. Default: `"slug"`. */
  orderBy?: OrderBy<ScribeDocument<z.infer<TSchema>>>;
  /** Custom validation across fields, run by `scribe validate`. */
  crossValidate?: (
    data: z.infer<TSchema>,
    ctx: CrossValidateContext,
  ) => CrossValidateIssue[];
  translate?: TranslateConfig;
}

/** A content type with all defaults applied (what runtimes and the CLI consume). */
export interface ContentTypeConfig<TSchema extends z.ZodTypeAny = z.ZodTypeAny>
  extends ContentTypeInput<TSchema> {
  contentDir: string;
  label: string;
  slugStrategy: SlugStrategy;
  indexFallback: IndexFallback;
}

/**
 * The shape accepted by `defineConfig()` / `createScribe()`.
 * Relative paths (`contentDir`, `store`) resolve against `rootDir`.
 */
export interface ScribeConfigInput<
  TTypes extends readonly ContentTypeInput<any>[] = readonly ContentTypeInput[],
> {
  /** Absolute project root (the directory holding `scribe.config.ts`). */
  rootDir: string;
  /** Directory containing the per-type content folders. Default: `"content"`. */
  contentDir?: string;
  /** Path to the SQLite translation store. Default: `".scribe/store.sqlite"`. */
  store?: string;
  /** All locales, including the default one. */
  locales: string[];
  /** Canonical source locale. Must be in `locales`. Default: `"en"`. */
  defaultLocale?: string;
  localePresets?: LocalePresets;
  translate?: ScribeTranslateDefaults;
  types: TTypes;
}

/**
 * A fully resolved Scribe config (all defaults applied, paths absolute).
 * Note: `rootDir` here is the absolute **content** root, not the project root.
 */
export interface ScribeConfig {
  /** Absolute content root (project `rootDir` + `contentDir`). */
  rootDir: string;
  /** Absolute path to the SQLite translation store. */
  storePath: string;
  locales: string[];
  defaultLocale: string;
  localePresets?: LocalePresets;
  translate?: ScribeTranslateDefaults;
  types: ContentTypeConfig[];
}

/** A loaded document (EN file or stored translation). */
export interface ScribeDocument<TFrontmatter = Record<string, unknown>> {
  /** Slug in this document's locale (differs from `enSlug` for localized slugs). */
  slug: string;
  /** Slug of the EN (default-locale) parent. Equal to `slug` for EN documents. */
  enSlug: string;
  locale: string;
  /** Inbound slug aliases (EN canonical docs only). */
  aliases: string[];
  /** Outbound retirement redirect, e.g. `/blog/successor-slug`. */
  redirectTo?: string;
  publishedAt?: string;
  updatedAt?: string;
  noindex: boolean;
  /** Explicit EN frontmatter override for canonical URL path. */
  canonicalPathOverride?: string;
  frontmatter: TFrontmatter;
  content: string;
  filePath?: string;
}

export interface LocaleIndex<TDoc = ScribeDocument> {
  bySlug: ReadonlyMap<string, TDoc>;
  byEnSlug: ReadonlyMap<string, TDoc>;
}

export type AllDocuments<TDoc = ScribeDocument> = ReadonlyMap<string, LocaleIndex<TDoc>>;

/** Result of `resolve()`: the document plus redirect/canonical routing data. */
export interface ResolvedDocument<TDoc = ScribeDocument> {
  document: TDoc | null;
  /** Locale actually served (differs from the requested locale on EN fallback). */
  actualLocale: string;
  /** 301 target when the slug is an alias or belongs to another locale. */
  shouldRedirectTo?: string;
  /** Locale-aware pathname when the type has `path` and a document was found. */
  canonicalPath?: string;
}

/** `{ locale, slug }` pairs for Next.js `generateStaticParams()`. */
export interface StaticParam {
  locale: string;
  slug: string;
}

export interface ListOptions<TDoc = ScribeDocument> {
  /** Override the type's configured `orderBy` for this call. */
  orderBy?: OrderBy<TDoc>;
  limit?: number;
}

/** Untyped default for the `related()` field map. */
export type AnyRelatedMap = Record<string, ScribeDocument | ScribeDocument[] | null>;

/**
 * Per-content-type runtime API.
 *
 * Reads: `list`, `get`, `resolve`. Routing: `staticParams`, `alternates`,
 * `translation`, `url`. Relations: `related`. Low-level escape hatch: `load`.
 */
export interface ContentTypeRuntime<
  TDoc extends ScribeDocument = ScribeDocument,
  TRelated extends Record<string, unknown> = AnyRelatedMap,
> {
  id: string;
  config: ContentTypeConfig;

  /** All documents for a locale (default: the default locale), sorted by the type's `orderBy`. */
  list: (locale?: string, options?: ListOptions<TDoc>) => TDoc[];
  /** Exact slug lookup in one locale (default: the default locale). No fallback, no redirects. */
  get: (slug: string, locale?: string) => TDoc | null;
  /** Full resolution: aliases, cross-locale slug correction, EN fallback, redirects, canonical path. */
  resolve: (slug: string, locale: string) => ResolvedDocument<TDoc>;

  /** Every `{ locale, slug }` pair to prerender — one call in `generateStaticParams()`. */
  staticParams: (options?: { locales?: readonly string[] }) => StaticParam[];
  /** hreflang map: locale → relative path, for every locale with a translation (default locale always included). */
  alternates: (doc: TDoc) => Record<string, string>;
  /** The same document in another locale, or null when untranslated (callers typically do `?? doc`). */
  translation: (doc: TDoc, targetLocale: string) => TDoc | null;
  /** Pathname for a slug + locale from the type's `path` template. */
  url: (slug: string, locale: string) => string;

  /** Dereference a `field.relation()` frontmatter field into the target type's document(s). */
  related: <K extends keyof TRelated & string>(
    doc: TDoc,
    field: K,
    locale?: string,
  ) => TRelated[K];

  /** Low-level access to the full locale → index map. Prefer `list`/`get`/`resolve`. */
  load: () => AllDocuments<TDoc>;
}

/** Infer the document type from a content type declaration. */
export type InferDocFromTypeConfig<T extends ContentTypeInput<any>> = ScribeDocument<
  z.infer<T["schema"]>
>;

/** Map content type id → document type from a config types tuple. */
export type InferDocMap<TTypes extends readonly ContentTypeInput<any>[]> = {
  [T in TTypes[number] as T["id"]]: InferDocFromTypeConfig<T>;
};

/** Document map (id → ScribeDocument) from a config object type. */
export type ScribeDocs<C extends { types: readonly ContentTypeInput<any>[] }> = InferDocMap<
  C["types"]
>;

/** Single doc type by content-type id. */
export type ScribeDocOf<
  C extends { types: readonly ContentTypeInput<any>[] },
  Id extends keyof ScribeDocs<C> & string,
> = ScribeDocs<C>[Id];

type RelationBrandOf<TField> = TField extends {
  [RELATION_BRAND]: infer B extends RelationBrand<string, boolean, boolean>;
}
  ? B
  : never;

/** Top-level `field.relation()` fields of a schema, keyed by field name. */
export type RelationFieldsOf<TSchema extends z.ZodTypeAny> =
  TSchema extends z.ZodObject<infer Shape>
    ? {
        [K in keyof Shape as [RelationBrandOf<Shape[K]>] extends [never]
          ? never
          : K]: RelationBrandOf<Shape[K]>;
      }
    : {};

type RelatedDoc<B, TDocMap> = B extends RelationBrand<
  infer TTarget,
  infer TMultiple,
  infer TOptional
>
  ? TTarget extends keyof TDocMap
    ? TMultiple extends true
      ? Array<TDocMap[TTarget]>
      : TOptional extends true
        ? TDocMap[TTarget] | null
        : TDocMap[TTarget]
  : never
  : never;

/** `related()` return types for a content type, derived from its schema's relation fields. */
export type RelatedMapFor<
  T extends ContentTypeInput<any>,
  TTypes extends readonly ContentTypeInput<any>[],
> = {
  [K in keyof RelationFieldsOf<T["schema"]> & string]: RelatedDoc<
    RelationFieldsOf<T["schema"]>[K],
    InferDocMap<TTypes>
  >;
};

/**
 * The typed Scribe client returned by `createScribe()`.
 * Each content type id becomes a typed accessor: `scribe.blog.list()`, `scribe.blog.related(doc, "author")`, …
 */
export type Scribe<TTypes extends readonly ContentTypeInput<any>[]> = {
  readonly [T in TTypes[number] as T["id"]]: ContentTypeRuntime<
    InferDocFromTypeConfig<T>,
    RelatedMapFor<T, TTypes>
  >;
} & {
  /** Sitemap entries (with hreflang alternates) for all routable types. */
  sitemap(
    options: import("../sitemap/types.js").GenerateSitemapOptions,
  ): Promise<import("../sitemap/types.js").SitemapEntry[]>;
  /** The resolved config (defaults applied, paths absolute). */
  config: ScribeConfig;
  project: ScribeProject;
  getType: ScribeProject["getType"];
  listTypes: ScribeProject["listTypes"];
};

/** Typed client type from a config object type (for app-side type aliases). */
export type ScribeClient<C extends { types: readonly ContentTypeInput<any>[] }> = Scribe<
  C["types"]
>;

/** Untyped project engine (CLI, validation, studio). Prefer `createScribe()` in apps. */
export interface ScribeProject {
  config: ScribeConfig;
  rootDir: string;
  storePath: string;
  getType: (id: string) => ContentTypeRuntime;
  listTypes: () => ContentTypeRuntime[];
}

/** Identity helper that preserves content-type id and schema inference. */
export function defineConfig<const TTypes extends readonly ContentTypeInput<any>[]>(
  config: ScribeConfigInput<TTypes>,
): ScribeConfigInput<TTypes> {
  return config;
}

/** Identity helper for a single content type entry. */
export function defineContentType<
  const TId extends string,
  TSchema extends z.ZodTypeAny,
>(
  config: ContentTypeInput<TSchema> & { id: TId },
): ContentTypeInput<TSchema> & { id: TId } {
  return config;
}
