import fs from "node:fs";
import type { ScribeConfig } from "../core/types.js";
import { createUrlBuilder, isRoutableType, type UrlBuilder } from "../i18n/build-url.js";
import { joinPublicPath } from "../loader/resolve-assets.js";
import { openStore, resolveStorePath } from "../storage/sqlite.js";
import { bulkLoadTranslations } from "../storage/translations.js";
import {
  extractInlineTokens,
  fillPlaceholders,
  unescapeInlineTokens,
  type InlineToken,
} from "./tokens.js";

/**
 * Read-time token resolver. Maps a single inline token to its string value given
 * the EN source document's frontmatter and a target locale.
 *
 * Relations resolve to a locale-aware URL via the existing `resolvePath`
 * machinery, using the target document's *localized* slug. Localized slugs live
 * in the translation store; the resolver reads them once per store revision
 * (keyed on the store file's mtime), never through another type's loader, so
 * there is no cross-loader recursion.
 */
export interface InlineResolver {
  resolve(
    token: InlineToken,
    enFrontmatter: Record<string, unknown>,
    locale: string,
  ): string;
}

/** How `:href` relation tokens resolve (see `docs/inline-tokens.md`). */
export type InlineLinkStyle = "app" | "export";

export interface CreateInlineResolverOptions {
  /** Default `"app"` — locale-free pathnames for framework routers. */
  linkStyle?: InlineLinkStyle;
  /** File extension appended to localized slugs in `"export"` mode. Default `.md`. */
  exportExtension?: `.${string}`;
}

function slugKey(typeId: string, enSlug: string, locale: string): string {
  return `${typeId}\u0000${enSlug}\u0000${locale}`;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every((v) => typeof v === "string");
}

export function createInlineResolver(
  config: ScribeConfig,
  options: CreateInlineResolverOptions = {},
): InlineResolver {
  const linkStyle = options.linkStyle ?? "app";
  const exportExtension = options.exportExtension ?? ".md";
  const urlBuilder: UrlBuilder = createUrlBuilder(config);
  const typeById = new Map(config.types.map((t) => [t.id, t]));
  const storePath = resolveStorePath(config);

  let slugCache: { mtime: number; index: Map<string, string> } | null = null;

  const localizedSlugIndex = (): Map<string, string> => {
    let mtime = 0;
    try {
      mtime = fs.statSync(storePath).mtimeMs;
    } catch {
      mtime = 0;
    }
    if (slugCache && slugCache.mtime === mtime) return slugCache.index;

    const index = new Map<string, string>();
    try {
      const db = openStore(config, "readonly");
      try {
        for (const row of bulkLoadTranslations(db)) {
          index.set(slugKey(row.content_type, row.en_slug, row.locale), row.slug);
        }
      } finally {
        db.close();
      }
    } catch {
      /* store missing or unreadable: fall back to EN slugs */
    }
    slugCache = { mtime, index };
    return index;
  };

  const localizedSlug = (typeId: string, enSlug: string, locale: string): string => {
    if (locale === config.defaultLocale) return enSlug;
    const index = localizedSlugIndex();
    const direct = index.get(slugKey(typeId, enSlug, locale));
    if (direct) return direct;
    for (const fb of config.localeFallbacks?.[locale] ?? []) {
      const hit = index.get(slugKey(typeId, enSlug, fb));
      if (hit) return hit;
    }
    return enSlug;
  };

  return {
    resolve(token, enFrontmatter, locale): string {
      switch (token.kind) {
        case "static":
          return token.text;

        case "var": {
          const vars = enFrontmatter.vars;
          if (isStringRecord(vars) && typeof vars[token.key] === "string") {
            return vars[token.key]!;
          }
          return "";
        }

        case "asset": {
          const assets = config.assets;
          return assets ? joinPublicPath(assets.publicPath, token.webPath) : token.webPath;
        }

        case "relation": {
          const type = typeById.get(token.targetTypeId);
          if (!type) return "";
          if (token.mode === "slug") return token.enSlug;
          if (!isRoutableType(type)) return "";
          const slug = localizedSlug(token.targetTypeId, token.enSlug, locale);
          if (linkStyle === "export") {
            return urlBuilder.resolvePath(type.path!, `${slug}${exportExtension}`, locale);
          }
          return type.path!.replace("{slug}", slug);
        }
      }
    },
  };
}

/**
 * Substitute inline tokens in an EN body at read time: extract tokens, resolve
 * each for the default locale, fill the placeholder markers, and unescape any
 * `$\{{` sequences. A body with no tokens is returned unchanged (aside from
 * unescaping).
 */
export function substituteEnInlineBody(
  rawBody: string,
  enFrontmatter: Record<string, unknown>,
  defaultLocale: string,
  resolver: InlineResolver,
): string {
  const { placeholderBody, tokens } = extractInlineTokens(rawBody);
  if (tokens.length === 0) return unescapeInlineTokens(placeholderBody);
  const values = tokens.map((t) => resolver.resolve(t, enFrontmatter, defaultLocale));
  return unescapeInlineTokens(fillPlaceholders(placeholderBody, values));
}

/**
 * Fill a stored translated body's `%%n%%` markers at read time. Tokens are
 * extracted from the CURRENT raw EN body and resolved for the document's locale,
 * so token VALUES (relation targets, asset paths, var values) always reflect the
 * live EN source even when the translation itself is older.
 */
export function fillTranslatedInlineBody(
  translatedBody: string,
  enRawBody: string,
  enFrontmatter: Record<string, unknown>,
  locale: string,
  resolver: InlineResolver,
): string {
  const { tokens } = extractInlineTokens(enRawBody);
  if (tokens.length === 0) return unescapeInlineTokens(translatedBody);
  const values = tokens.map((t) => resolver.resolve(t, enFrontmatter, locale));
  return unescapeInlineTokens(fillPlaceholders(translatedBody, values));
}
