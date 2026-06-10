import { z } from "zod";
import { extractSlugFromResolvedPath, pathPrefix, pathSuffix, resolvePath } from "../i18n/build-url.js";
import type { ContentTypeConfig, ScribeDocument } from "./types.js";

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const slugPatternSchema = z
  .string()
  .regex(SLUG_PATTERN, "slug must be lowercase-kebab-case");

export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T[\d:.Z+-]*)?$/, "Use ISO date YYYY-MM-DD or full ISO 8601");

const canonicalPathSchema = z.string().regex(/^\//, "canonicalPath must start with /");

export interface BuiltinEnFields {
  aliases: string[];
  redirectTo?: string;
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

/** Extract built-in EN frontmatter (aliases, dates, SEO) before Zod validation. */
export function extractBuiltinEnFields(
  data: Record<string, unknown>,
  pathTemplate: string | undefined,
  enSlug: string,
  defaultLocale: string,
): {
  builtin: BuiltinEnFields;
  rest: Record<string, unknown>;
  issues: BuiltinParseIssue[];
} {
  const issues: BuiltinParseIssue[] = [];
  const rest = { ...data };

  const aliasesResult = z.array(slugPatternSchema).max(20).optional().default([]).safeParse(rest.aliases ?? []);
  delete rest.aliases;

  const redirectRaw = rest.redirect_to;
  delete rest.redirect_to;

  let redirectTo: string | undefined;
  if (redirectRaw !== undefined && redirectRaw !== null && redirectRaw !== "") {
    if (typeof redirectRaw !== "string") {
      issues.push({
        field: "redirect_to",
        message: "redirect_to must be a string path",
        level: "error",
      });
    } else if (!pathTemplate) {
      issues.push({
        field: "redirect_to",
        message: "redirect_to is not allowed on reference-only content types",
        level: "error",
      });
    } else if (!extractSlugFromResolvedPath(pathTemplate, redirectRaw)) {
      issues.push({
        field: "redirect_to",
        message: `redirect_to must match path template "${pathTemplate}" (prefix "${pathPrefix(pathTemplate)}"${pathSuffix(pathTemplate) ? `, suffix "${pathSuffix(pathTemplate)}"` : ""})`,
        level: "error",
      });
    } else {
      redirectTo = redirectRaw;
    }
  }

  const aliases = aliasesResult.success ? aliasesResult.data : [];
  if (!aliasesResult.success) {
    for (const issue of aliasesResult.error.issues) {
      issues.push({
        field: `aliases.${issue.path.join(".")}`,
        message: issue.message,
        level: "error",
      });
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
      aliases,
      redirectTo,
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
): string {
  if (doc.canonicalPathOverride) {
    if (doc.locale === defaultLocale) return doc.canonicalPathOverride;
    return `/${doc.locale}${doc.canonicalPathOverride}`;
  }
  if (!type.path) return `/${doc.slug}`;
  return resolvePath(type.path, doc.slug, doc.locale, defaultLocale);
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
): Record<string, unknown> {
  const out = { ...frontmatter };
  if (doc.publishedAt !== undefined) out.publishedAt = doc.publishedAt;
  if (doc.updatedAt !== undefined) out.updatedAt = doc.updatedAt;
  out.noindex = doc.noindex;
  out.canonicalPath = resolveCanonicalPathname(type, doc, defaultLocale);
  return out;
}

export function seoFieldsFromEn(enDoc: ScribeDocument): Pick<
  ScribeDocument,
  "publishedAt" | "updatedAt" | "noindex" | "canonicalPathOverride" | "redirectTo"
> {
  return {
    publishedAt: enDoc.publishedAt,
    updatedAt: enDoc.updatedAt,
    noindex: enDoc.noindex,
    canonicalPathOverride: enDoc.canonicalPathOverride,
    redirectTo: enDoc.redirectTo,
  };
}
