import type { ContentTypeConfig } from "../core/types.js";

const SLUG_PLACEHOLDER = "{slug}";

/** Whether a content type has a public URL path template. */
export function isRoutableType(type: Pick<ContentTypeConfig, "path">): boolean {
  return typeof type.path === "string" && type.path.length > 0;
}

/** Validate path template at project init. */
export function assertValidPathTemplate(path: string, typeId: string): void {
  if (!path.startsWith("/")) {
    throw new Error(`Content type "${typeId}": path must start with / (got "${path}")`);
  }
  const count = (path.match(/\{slug\}/g) ?? []).length;
  if (count !== 1) {
    throw new Error(
      `Content type "${typeId}": path must contain exactly one {slug} (got "${path}")`,
    );
  }
}

/** Segment before `{slug}` in the template, e.g. `/blog/` from `/blog/{slug}`. */
export function pathPrefix(template: string): string {
  const idx = template.indexOf(SLUG_PLACEHOLDER);
  if (idx === -1) throw new Error(`Invalid path template (missing {slug}): ${template}`);
  return template.slice(0, idx);
}

/** Segment after `{slug}` in the template, e.g. `/advanced` from `/blog/{slug}/advanced`. */
export function pathSuffix(template: string): string {
  const idx = template.indexOf(SLUG_PLACEHOLDER);
  if (idx === -1) throw new Error(`Invalid path template (missing {slug}): ${template}`);
  return template.slice(idx + SLUG_PLACEHOLDER.length);
}

/** Build a locale-aware pathname from a path template and slug. */
export function resolvePath(
  template: string,
  slug: string,
  locale: string,
  defaultLocale: string,
): string {
  const relative = template.replace(SLUG_PLACEHOLDER, slug);
  if (locale === defaultLocale) return relative;
  return `/${locale}${relative}`;
}

/** Extract slug from a resolved path that matches the template. */
export function extractSlugFromResolvedPath(template: string, resolvedPath: string): string | null {
  const prefix = pathPrefix(template);
  const suffix = pathSuffix(template);
  if (!resolvedPath.startsWith(prefix)) return null;
  if (suffix && !resolvedPath.endsWith(suffix)) return null;
  const slugEnd = suffix ? resolvedPath.length - suffix.length : resolvedPath.length;
  const slug = resolvedPath.slice(prefix.length, slugEnd);
  return slug.length > 0 ? slug : null;
}
