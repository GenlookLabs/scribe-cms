/**
 * Cross-locale slug rescue.
 *
 * Localized slug strategies create a failure mode where a known slug is
 * requested under the wrong locale prefix (`/da/blog/<spanish-slug>`): locale
 * switchers that swap the prefix without translating the slug, `pref_locale`
 * style redirects, and crawlers exploring the locale × slug matrix. Those
 * URLs must 301 to the document's URL in the requested locale — never 404,
 * and never serve content on a non-canonical URL.
 *
 * Pure and dependency-free so it can run in edge middleware against the
 * build-generated alternates/redirects JSON maps.
 */

/** One hreflang cluster: locale code (plus optional "x-default") → pathname. */
export type AlternateCluster = Record<string, string>;

/** Every locale variant pathname of a document → its full cluster. */
export type AlternatesMap = Record<string, AlternateCluster>;

export interface CrossLocaleRescueConfig {
  /** All locale codes, including the default locale. */
  locales: readonly string[];
  /** Default locale — its URLs carry no prefix. */
  defaultLocale: string;
  /**
   * Optional flat content-redirect map (source pathname → destination
   * pathname). Lets the rescue also catch RETIRED slugs under a wrong locale
   * prefix: the slug's own-locale redirect destination is hopped through the
   * alternates cluster to the requested locale.
   */
  redirects?: Record<string, string>;
}

export interface CrossLocaleRescue {
  /**
   * 301 target for a known slug under the wrong locale prefix, or null when
   * the pathname is a real page, an exact redirect source (let the caller's
   * redirect map handle it), an unknown slug, or an ambiguous slug.
   */
  resolve(pathname: string): string | null;
}

const AMBIGUOUS = Symbol("ambiguous");

interface ParsedPath {
  locale: string;
  /** Path template segments between locale prefix and slug ("blog", "shopify/vs"). */
  prefix: string;
  slug: string;
}

function parsePath(
  pathname: string,
  locales: ReadonlySet<string>,
  defaultLocale: string
): ParsedPath | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return null;
  let locale = defaultLocale;
  if (locales.has(segments[0]) && segments[0] !== defaultLocale) {
    locale = segments[0];
    segments.shift();
  }
  if (segments.length < 2) return null; // need at least prefix + slug
  const slug = segments[segments.length - 1];
  const prefix = segments.slice(0, -1).join("/");
  return { locale, prefix, slug };
}

function slugKey(prefix: string, slug: string): string {
  return `${prefix}\0${slug}`;
}

function clusterCanonical(cluster: AlternateCluster, defaultLocale: string): string {
  return cluster["x-default"] ?? cluster[defaultLocale] ?? Object.values(cluster)[0] ?? "";
}

export function createCrossLocaleRescue(
  alternates: AlternatesMap,
  config: CrossLocaleRescueConfig
): CrossLocaleRescue {
  const locales = new Set(config.locales);
  const { defaultLocale, redirects } = config;

  // slug (+ path prefix) → its hreflang cluster; collisions across distinct
  // documents are dropped rather than guessed.
  const clusterIndex = new Map<string, AlternateCluster | typeof AMBIGUOUS>();
  for (const [pathname, cluster] of Object.entries(alternates)) {
    const parsed = parsePath(pathname, locales, defaultLocale);
    if (!parsed) continue;
    const key = slugKey(parsed.prefix, parsed.slug);
    const existing = clusterIndex.get(key);
    if (existing === undefined) {
      clusterIndex.set(key, cluster);
    } else if (
      existing !== AMBIGUOUS &&
      existing !== cluster &&
      clusterCanonical(existing, defaultLocale) !== clusterCanonical(cluster, defaultLocale)
    ) {
      clusterIndex.set(key, AMBIGUOUS);
    }
  }

  // Retired slug (+ prefix) → destination per SOURCE locale. Redirect maps
  // legitimately repeat one slug under several locale prefixes with
  // locale-specific destinations, so slots are keyed by the source's locale;
  // only a same-slug same-locale conflict is a real ambiguity.
  const redirectIndex = new Map<string, Map<string, string | typeof AMBIGUOUS>>();
  if (redirects) {
    for (const [source, destination] of Object.entries(redirects)) {
      const parsed = parsePath(source, locales, defaultLocale);
      if (!parsed) continue;
      const key = slugKey(parsed.prefix, parsed.slug);
      let slots = redirectIndex.get(key);
      if (!slots) {
        slots = new Map();
        redirectIndex.set(key, slots);
      }
      const existing = slots.get(parsed.locale);
      if (existing === undefined) {
        slots.set(parsed.locale, destination);
      } else if (existing !== AMBIGUOUS && existing !== destination) {
        slots.set(parsed.locale, AMBIGUOUS);
      }
    }
  }

  return {
    resolve(pathname: string): string | null {
      if (alternates[pathname]) return null;
      if (redirects && redirects[pathname]) return null;
      const parsed = parsePath(pathname, locales, defaultLocale);
      if (!parsed) return null;
      const key = slugKey(parsed.prefix, parsed.slug);

      const cluster = clusterIndex.get(key);
      if (cluster && cluster !== AMBIGUOUS) {
        const target = cluster[parsed.locale] ?? cluster[defaultLocale] ?? cluster["x-default"];
        return target && target !== pathname ? target : null;
      }

      const slots = redirectIndex.get(key);
      if (slots) {
        // Prefer the default locale's destination, else any unambiguous slot,
        // then hop it through its cluster to the requested locale.
        let destination = slots.get(defaultLocale);
        if (destination === undefined || destination === AMBIGUOUS) {
          destination = undefined;
          for (const slot of slots.values()) {
            if (slot !== AMBIGUOUS) {
              destination = slot;
              break;
            }
          }
        }
        if (destination) {
          const destCluster = alternates[destination];
          const target = destCluster
            ? destCluster[parsed.locale] ?? destCluster[defaultLocale] ?? destination
            : destination;
          return target !== pathname ? target : null;
        }
      }

      return null;
    },
  };
}
