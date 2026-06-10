import type { ContentTypeConfig, ScribeDocument } from "../core/types.js";

export type SitemapChangeFrequency =
  | "always"
  | "hourly"
  | "daily"
  | "weekly"
  | "monthly"
  | "yearly"
  | "never";

export interface SitemapAlternateLanguages {
  languages?: Record<string, string>;
}

/** JSON-serializable sitemap entry (Next.js-compatible shape). */
export interface SitemapEntry {
  url: string;
  /** ISO 8601 — sourced from Scribe `updatedAt`, falling back to `publishedAt`. */
  lastModified?: string;
  changeFrequency?: SitemapChangeFrequency;
  priority?: number;
  alternates?: SitemapAlternateLanguages;
}

export interface SitemapTypeDefaults {
  changeFrequency?: SitemapChangeFrequency;
  priority?: number;
}

export interface GenerateSitemapOptions {
  /** Site origin, e.g. `https://example.com` (no trailing slash). */
  baseUrl: string;
  /**
   * Resolve a locale-specific pathname to an absolute URL.
   * `pathname` always starts with `/`.
   * Default: `(locale, pathname) => joinBaseUrl(baseUrl, pathname)`.
   */
  resolveUrl?: (locale: string, pathname: string) => string | Promise<string>;
  /** Routable content types to include. Defaults to every type with a `path`. */
  contentTypes?: string[];
  /** Per-type sitemap defaults. */
  typeDefaults?: Record<string, SitemapTypeDefaults>;
  /** Override pathname resolution for a loaded document. */
  resolvePathname?: (
    type: ContentTypeConfig,
    doc: ScribeDocument,
    defaultLocale: string,
  ) => string;
  /** Skip documents with `noindex: true`. Default true. */
  excludeNoindex?: boolean;
  /** Add `alternates.languages["x-default"]` pointing at the default locale URL. Default true. */
  includeXDefault?: boolean;
}
