import type { ContentTypeConfig, LocaleRoutingConfig, ScribeConfig } from "../core/types.js";

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

function resolveDefaultLocaleRouting(): LocaleRoutingConfig {
  return { strategy: "path-prefix", prefixDefaultLocale: false };
}

function splitPathAndSearch(pathname: string): { pathname: string; search: string } {
  const q = pathname.indexOf("?");
  if (q === -1) return { pathname, search: "" };
  return { pathname: pathname.slice(0, q), search: pathname.slice(q) };
}

export interface UrlBuilder {
  defaultLocale: string;
  locales: readonly string[];
  localeRouting: LocaleRoutingConfig;
  /** Locales that receive a non-default locale marker in generated URLs. */
  prefixedLocales: string[];
  resolvePath: (template: string, slug: string, locale: string) => string;
  extractSlugFromResolvedPath: (template: string, resolvedPath: string) => string | null;
  /** Apply locale routing to an already-resolved pathname (e.g. canonicalPath override). */
  applyLocaleToPath: (pathname: string, locale: string) => string;
}

/** Create a locale-aware URL builder from a resolved Scribe config. */
export function createUrlBuilder(config: Pick<ScribeConfig, "locales" | "defaultLocale" | "localeRouting">): UrlBuilder {
  const localeRouting = config.localeRouting ?? resolveDefaultLocaleRouting();
  const defaultLocale = config.defaultLocale;
  const prefixedLocales =
    localeRouting.strategy === "path-prefix"
      ? localeRouting.prefixDefaultLocale
        ? [...config.locales]
        : config.locales.filter((locale) => locale !== defaultLocale)
      : config.locales.filter((locale) => locale !== defaultLocale);

  function applyLocaleToPath(pathname: string, locale: string): string {
    if (locale === defaultLocale) {
      if (localeRouting.strategy === "path-prefix" && localeRouting.prefixDefaultLocale) {
        return `/${defaultLocale}${pathname}`;
      }
      return pathname;
    }

    if (localeRouting.strategy === "search-param") {
      const { pathname: base, search } = splitPathAndSearch(pathname);
      const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
      params.set(localeRouting.param, locale);
      const qs = params.toString();
      return qs ? `${base}?${qs}` : base;
    }

    return `/${locale}${pathname}`;
  }

  function resolvePath(template: string, slug: string, locale: string): string {
    const relative = template.replace(SLUG_PLACEHOLDER, slug);
    return applyLocaleToPath(relative, locale);
  }

  function extractSlugFromResolvedPath(template: string, resolvedPath: string): string | null {
    let pathname = resolvedPath;
    if (localeRouting.strategy === "search-param") {
      pathname = splitPathAndSearch(resolvedPath).pathname;
    } else if (localeRouting.strategy === "path-prefix") {
      for (const locale of config.locales) {
        if (locale === defaultLocale && !localeRouting.prefixDefaultLocale) continue;
        const prefix = `/${locale}`;
        if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
          pathname = pathname.slice(prefix.length) || "/";
          break;
        }
      }
    }

    const prefix = pathPrefix(template);
    const suffix = pathSuffix(template);
    if (!pathname.startsWith(prefix)) return null;
    if (suffix && !pathname.endsWith(suffix)) return null;
    const slugEnd = suffix ? pathname.length - suffix.length : pathname.length;
    const slug = pathname.slice(prefix.length, slugEnd);
    return slug.length > 0 ? slug : null;
  }

  return {
    defaultLocale,
    locales: config.locales,
    localeRouting,
    prefixedLocales,
    resolvePath,
    extractSlugFromResolvedPath,
    applyLocaleToPath,
  };
}

/** Build a locale-aware pathname from a path template and slug. */
export function resolvePath(
  template: string,
  slug: string,
  locale: string,
  defaultLocale: string,
  localeRouting?: LocaleRoutingConfig,
): string {
  const builder = createUrlBuilder({
    locales: [defaultLocale, ...(locale !== defaultLocale ? [locale] : [])],
    defaultLocale,
    localeRouting: localeRouting ?? resolveDefaultLocaleRouting(),
  });
  return builder.resolvePath(template, slug, locale);
}

/** Extract slug from a resolved path that matches the template. */
export function extractSlugFromResolvedPath(
  template: string,
  resolvedPath: string,
  localeRouting?: LocaleRoutingConfig,
): string | null {
  const builder = createUrlBuilder({
    locales: [],
    defaultLocale: "en",
    localeRouting: localeRouting ?? resolveDefaultLocaleRouting(),
  });
  return builder.extractSlugFromResolvedPath(template, resolvedPath);
}
