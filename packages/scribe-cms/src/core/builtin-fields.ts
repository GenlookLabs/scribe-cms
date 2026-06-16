import { z } from "zod";
import { createUrlBuilder, pathPrefix, pathSuffix } from "../i18n/build-url.js";
import type { ContentTypeConfig, LocaleRoutingConfig, ScribeDocument } from "./types.js";

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const slugPatternSchema = z
  .string()
  .regex(SLUG_PATTERN, "slug must be lowercase-kebab-case");

export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T[\d:.Z+-]*)?$/, "Use ISO date YYYY-MM-DD or full ISO 8601");

const canonicalPathSchema = z.string().regex(/^\//, "canonicalPath must start with /");

export interface BuiltinEnFields {
  publishedAt?: string;
  updatedAt?: string;
  noindex: boolean;
  /** Set only when explicitly provided in EN frontmatter. */
  canonicalPathOverride?: string;
}

export interface BuiltinParseIssue {
  field: string;
  message: string;
  level: "error" | "warning";
}

const LOCALE_BUILTIN_KEYS: Array<[string, string]> = [
  ["publishedAt", "publishedAt is EN-only; inherited from the EN parent at load time"],
  ["updatedAt", "updatedAt is EN-only; inherited from the EN parent at load time"],
  ["noindex", "noindex is EN-only; inherited from the EN parent at load time"],
  ["canonicalPath", "canonicalPath is EN-only; inherited from the EN parent at load time"],
  ["aliases", "aliases is EN-only; remove from locale translation"],
  ["redirect_to", "redirect_to is EN-only; remove from locale translation"],
  ["translationOf", "translationOf is internal; remove from locale translation"],
  ["enSlug", "enSlug is internal; remove from locale translation"],
];

const DEPRECATED_REDIRECT_FIELDS: Array<[string, string]> = [
  [
    "aliases",
    "aliases frontmatter is removed — add redirects to content/<type>/_redirects.json instead",
  ],
  [
    "redirect_to",
    "redirect_to frontmatter is removed — add redirects to content/<type>/_redirects.json instead",
  ],
];

/** Extract built-in EN frontmatter (dates, SEO) before Zod validation. */
export function extractBuiltinEnFields(
  data: Record<string, unknown>,
  _pathTemplate: string | undefined,
  _enSlug: string,
  _defaultLocale: string,
): {
  builtin: BuiltinEnFields;
  rest: Record<string, unknown>;
  issues: BuiltinParseIssue[];
} {
  const issues: BuiltinParseIssue[] = [];
  const rest = { ...data };

  for (const [field, message] of DEPRECATED_REDIRECT_FIELDS) {
    if (rest[field] !== undefined) {
      issues.push({ field, message, level: "error" });
      delete rest[field];
    }
  }

  let publishedAt: string | undefined;
  if (rest.publishedAt !== undefined && rest.publishedAt !== null && rest.publishedAt !== "") {
    const parsed = isoDateSchema.safeParse(rest.publishedAt);
    if (parsed.success) {
      publishedAt = parsed.data;
    } else {
      for (const issue of parsed.error.issues) {
        issues.push({ field: "publishedAt", message: issue.message, level: "error" });
      }
    }
    delete rest.publishedAt;
  }

  let updatedAt: string | undefined;
  if (rest.updatedAt !== undefined && rest.updatedAt !== null && rest.updatedAt !== "") {
    const parsed = isoDateSchema.safeParse(rest.updatedAt);
    if (parsed.success) {
      updatedAt = parsed.data;
    } else {
      for (const issue of parsed.error.issues) {
        issues.push({ field: "updatedAt", message: issue.message, level: "error" });
      }
    }
    delete rest.updatedAt;
  } else if (publishedAt) {
    updatedAt = publishedAt;
  }

  let noindex = false;
  if (rest.noindex !== undefined && rest.noindex !== null && rest.noindex !== "") {
    if (typeof rest.noindex === "boolean") {
      noindex = rest.noindex;
    } else {
      issues.push({ field: "noindex", message: "noindex must be a boolean", level: "error" });
    }
    delete rest.noindex;
  }

  let canonicalPathOverride: string | undefined;
  if (rest.canonicalPath !== undefined && rest.canonicalPath !== null && rest.canonicalPath !== "") {
    const parsed = canonicalPathSchema.safeParse(rest.canonicalPath);
    if (parsed.success) {
      canonicalPathOverride = parsed.data;
    } else {
      for (const issue of parsed.error.issues) {
        issues.push({ field: "canonicalPath", message: issue.message, level: "error" });
      }
    }
    delete rest.canonicalPath;
  }

  for (const internalKey of ["translationOf", "enSlug"] as const) {
    if (rest[internalKey] !== undefined) {
      issues.push({
        field: internalKey,
        message: `${internalKey} is managed internally by Scribe; remove from frontmatter`,
        level: "warning",
      });
      delete rest[internalKey];
    }
  }

  return {
    builtin: {
      publishedAt,
      updatedAt,
      noindex,
      canonicalPathOverride,
    },
    rest,
    issues,
  };
}

/** Reject built-in keys on locale translation frontmatter. */
export function validateLocaleBuiltinFields(data: Record<string, unknown>): BuiltinParseIssue[] {
  const issues: BuiltinParseIssue[] = [];
  for (const [key, message] of LOCALE_BUILTIN_KEYS) {
    if (data[key] !== undefined) {
      issues.push({ field: key, message, level: "error" });
    }
  }
  return issues;
}

/** ISO date for sitemap lastmod from updatedAt or publishedAt. */
export function documentLastModified(doc: {
  updatedAt?: string;
  publishedAt?: string;
}): string | undefined {
  const raw = doc.updatedAt ?? doc.publishedAt;
  if (!raw) return undefined;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** Locale-aware pathname for a document. */
export function resolveCanonicalPathname(
  type: Pick<ContentTypeConfig, "path">,
  doc: Pick<ScribeDocument, "slug" | "locale" | "canonicalPathOverride">,
  defaultLocale: string,
  localeRouting?: LocaleRoutingConfig,
): string {
  const urlBuilder = createUrlBuilder({
    locales: [defaultLocale, ...(doc.locale !== defaultLocale ? [doc.locale] : [])],
    defaultLocale,
    localeRouting: localeRouting ?? { strategy: "path-prefix", prefixDefaultLocale: false },
  });

  if (doc.canonicalPathOverride) {
    return urlBuilder.applyLocaleToPath(doc.canonicalPathOverride, doc.locale);
  }
  if (!type.path) return `/${doc.slug}`;
  return urlBuilder.resolvePath(type.path, doc.slug, doc.locale);
}

/** Hydrate locale frontmatter with EN-only built-in fields at load time. */
export function mergeBuiltinsIntoFrontmatter(
  frontmatter: Record<string, unknown>,
  doc: Pick<
    ScribeDocument,
    "publishedAt" | "updatedAt" | "noindex" | "canonicalPathOverride" | "slug" | "locale"
  >,
  type: Pick<ContentTypeConfig, "path">,
  defaultLocale: string,
  localeRouting?: LocaleRoutingConfig,
): Record<string, unknown> {
  const out = { ...frontmatter };
  if (doc.publishedAt !== undefined) out.publishedAt = doc.publishedAt;
  if (doc.updatedAt !== undefined) out.updatedAt = doc.updatedAt;
  out.noindex = doc.noindex;
  out.canonicalPath = resolveCanonicalPathname(type, doc, defaultLocale, localeRouting);
  return out;
}

export function seoFieldsFromEn(enDoc: ScribeDocument): Pick<
  ScribeDocument,
  "publishedAt" | "updatedAt" | "noindex" | "canonicalPathOverride"
> {
  return {
    publishedAt: enDoc.publishedAt,
    updatedAt: enDoc.updatedAt,
    noindex: enDoc.noindex,
    canonicalPathOverride: enDoc.canonicalPathOverride,
  };
}

export { pathPrefix, pathSuffix };
