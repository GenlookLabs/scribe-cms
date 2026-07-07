import type {
  ContentTypeConfig,
  ContentTypeRuntime,
  ListOptions,
  OrderBy,
  ScribeConfig,
  ScribeDocument,
  ScribeProject,
  StaticParam,
} from "./core/types.js";
import { listRelationFields, type SchemaFieldMeta } from "./core/introspect-schema.js";
import { createContentLoader } from "./loader/create-loader.js";
import { resolveLocalizedDocument } from "./i18n/resolve-document.js";
import { createUrlBuilder, isRoutableType } from "./i18n/build-url.js";

function comparatorFor(orderBy: OrderBy): (a: ScribeDocument, b: ScribeDocument) => number {
  if (typeof orderBy === "function") return orderBy;
  switch (orderBy) {
    case "publishedAt":
      return (a, b) => (a.publishedAt ?? "").localeCompare(b.publishedAt ?? "");
    case "-publishedAt":
      return (a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "");
    case "updatedAt":
      return (a, b) => (a.updatedAt ?? "").localeCompare(b.updatedAt ?? "");
    case "-updatedAt":
      return (a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
    default:
      return (a, b) => a.slug.localeCompare(b.slug);
  }
}

function buildRuntime(
  config: ScribeConfig,
  type: ContentTypeConfig,
  getRuntime: (id: string) => ContentTypeRuntime,
  options: { resolveAssets?: boolean } = {},
): ContentTypeRuntime {
  const load = createContentLoader(config, type, { resolveAssets: options.resolveAssets });
  const relationFields = new Map<string, SchemaFieldMeta>(
    listRelationFields(type.schema)
      .filter((f) => f.path.length === 1)
      .map((f) => [f.path[0]!, f]),
  );

  function assertRoutable(method: string): string {
    if (!type.path) {
      throw new Error(
        `Content type "${type.id}" has no path template — ${method}() requires one`,
      );
    }
    return type.path;
  }

  const urlBuilder = createUrlBuilder(config);

  const runtime: ContentTypeRuntime = {
    id: type.id,
    config: type,
    load,

    list(locale = config.defaultLocale, options: ListOptions = {}) {
      const idx = load().get(locale);
      if (!idx) return [];
      const docs = Array.from(idx.bySlug.values());
      docs.sort(comparatorFor(options.orderBy ?? type.orderBy ?? "slug"));
      return options.limit !== undefined ? docs.slice(0, options.limit) : docs;
    },

    get(slug: string, locale = config.defaultLocale) {
      return load().get(locale)?.bySlug.get(slug) ?? null;
    },

    resolve(slug: string, locale: string) {
      const result = resolveLocalizedDocument(
        slug,
        locale,
        config.defaultLocale,
        load(),
        type,
        config.localeRouting,
        config.localeFallbacks?.[locale] ?? [],
      );
      if (result.document && type.path) {
        return {
          ...result,
          canonicalPath: urlBuilder.resolvePath(
            type.path,
            result.document.slug,
            result.actualLocale,
          ),
        };
      }
      return result;
    },

    staticParams(options = {}) {
      assertRoutable("staticParams");
      const all = load();
      const enIdx = all.get(config.defaultLocale);
      if (!enIdx) return [];
      const params: StaticParam[] = [];
      for (const locale of options.locales ?? config.locales) {
        const localeIdx = all.get(locale);
        const fallbacks = config.localeFallbacks?.[locale] ?? [];
        for (const doc of enIdx.bySlug.values()) {
          let slug: string;
          if (locale === config.defaultLocale) {
            slug = doc.slug;
          } else {
            // Prefer the locale's own translated slug, then each fallback
            // locale's translated slug, then the EN slug — matching resolve().
            slug =
              localeIdx?.byEnSlug.get(doc.slug)?.slug ??
              fallbacks
                .map((fb) => all.get(fb)?.byEnSlug.get(doc.slug)?.slug)
                .find((s): s is string => s !== undefined) ??
              doc.slug;
          }
          params.push({ locale, slug });
        }
      }
      return params;
    },

    alternates(doc: ScribeDocument) {
      const pathTemplate = assertRoutable("alternates");
      const out: Record<string, string> = {
        [config.defaultLocale]: urlBuilder.resolvePath(
          pathTemplate,
          doc.enSlug,
          config.defaultLocale,
        ),
      };
      const all = load();
      for (const locale of config.locales) {
        if (locale === config.defaultLocale) continue;
        const translated = all.get(locale)?.byEnSlug.get(doc.enSlug);
        if (translated) {
          out[locale] = urlBuilder.resolvePath(pathTemplate, translated.slug, locale);
        }
      }
      return out;
    },

    translation(doc: ScribeDocument, targetLocale: string) {
      if (targetLocale === doc.locale) return doc;
      const all = load();
      if (targetLocale === config.defaultLocale) {
        return all.get(config.defaultLocale)?.bySlug.get(doc.enSlug) ?? null;
      }
      return all.get(targetLocale)?.byEnSlug.get(doc.enSlug) ?? null;
    },

    url(slug: string, locale: string) {
      const pathTemplate = assertRoutable("url");
      return urlBuilder.resolvePath(pathTemplate, slug, locale);
    },

    related(doc: ScribeDocument, fieldName: string, locale?: string) {
      const meta = relationFields.get(fieldName);
      if (!meta) {
        throw new Error(
          `Content type "${type.id}" has no top-level relation field "${fieldName}"`,
        );
      }
      const target = getRuntime(meta.relationTarget!);
      const lookupLocale = locale ?? doc.locale;
      const value = (doc.frontmatter as Record<string, unknown>)[fieldName];

      // Relations always hold EN slugs (structural fields are merged from EN).
      // Deref in the requested locale, falling back to the EN doc unconditionally.
      const deref = (enSlug: string): ScribeDocument | null => {
        const all = target.load();
        return (
          all.get(lookupLocale)?.byEnSlug.get(enSlug) ??
          all.get(config.defaultLocale)?.bySlug.get(enSlug) ??
          null
        );
      };

      if (meta.relationMultiple) {
        if (!Array.isArray(value)) return [];
        return value
          .filter((slug): slug is string => typeof slug === "string" && slug.length > 0)
          .map(deref)
          .filter((d): d is ScribeDocument => d !== null);
      }

      if (typeof value !== "string" || value.length === 0) {
        if (meta.relationOptional) return null;
        throw new Error(
          `${type.id} "${doc.enSlug}": required relation "${fieldName}" is missing`,
        );
      }
      const resolved = deref(value);
      if (!resolved && !meta.relationOptional) {
        throw new Error(
          `${type.id} "${doc.enSlug}": relation "${fieldName}" references missing ` +
            `${meta.relationTarget} "${value}" — run \`scribe validate\``,
        );
      }
      return resolved;
    },
  } as ContentTypeRuntime;

  return runtime;
}

/**
 * Create the untyped project engine (CLI, validation, studio).
 * Apps should use `createScribe()` for typed per-type accessors.
 * Expects a resolved config (`resolveConfig` / `loadConfigSync`).
 *
 * @param options.resolveAssets resolve declared asset fields to served URLs on
 *   read (publicPath applied, templates materialized). Only `createScribe` sets
 *   this; the CLI, validation, and static exports keep source values.
 * @internal
 */
export function createProject(
  config: ScribeConfig,
  options: { resolveAssets?: boolean } = {},
): ScribeProject {
  const runtimes = new Map<string, ContentTypeRuntime>();
  const getRuntime = (id: string): ContentTypeRuntime => {
    const runtime = runtimes.get(id);
    if (!runtime) {
      throw new Error(`Unknown content type "${id}"`);
    }
    return runtime;
  };

  for (const type of config.types) {
    runtimes.set(type.id, buildRuntime(config, type, getRuntime, options));
  }

  return {
    config,
    rootDir: config.rootDir,
    storePath: config.storePath,
    getType: getRuntime,
    listTypes() {
      return Array.from(runtimes.values());
    },
    listRoutableTypes() {
      return Array.from(runtimes.values()).filter((runtime) => isRoutableType(runtime.config));
    },
  };
}
