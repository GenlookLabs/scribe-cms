import type { ScribeProject } from "../core/types.js";
import { isRoutableType, pathPrefix, createUrlBuilder } from "../i18n/build-url.js";
import { serializeMdx } from "../loader/parse-mdx.js";

export interface StaticRawExport {
  /** Path relative to the output root (e.g. `blog/foo.mdx`, `fr/glossary/bar.mdx`). */
  relativePath: string;
  /** Public URL pathname (e.g. `/blog/foo.mdx`, `/fr/glossary/bar.mdx`). */
  urlPath: string;
  locale: string;
  typeId: string;
  enSlug: string;
  /** Full MDX source (YAML frontmatter + body). */
  source: string;
}

export interface BuildStaticRawExportsOptions {
  /** File extension including the dot. Default `.mdx`. */
  extension?: `.${string}`;
  /** Content type ids to export. Default: all routable types. */
  types?: string[];
  /** Locales to export. Default: `config.locales`. */
  locales?: readonly string[];
  /** Skip documents where `resolve()` sets `shouldRedirectTo`. Default `true`. */
  excludeRedirected?: boolean;
  /** Skip documents with `noindex: true`. Default `false`. */
  excludeNoindex?: boolean;
}

function normalizeExtension(ext: string): `.${string}` {
  return (ext.startsWith(".") ? ext : `.${ext}`) as `.${string}`;
}

/** Segment name for export directories, e.g. `blog` from `/blog/{slug}`. */
export function exportDirSegment(pathTemplate: string): string {
  const prefix = pathPrefix(pathTemplate);
  return prefix.replace(/^\/+|\/+$/g, "");
}

/**
 * Relative directory roots to clean before writing static exports.
 * EN: `{segment}/` (e.g. `blog/`). Prefixed locales: `{locale}/{segment}/`.
 */
export function getStaticExportRoots(
  project: ScribeProject,
  options: { types?: string[]; locales?: readonly string[] } = {},
): string[] {
  const { config } = project;
  const locales = options.locales ?? config.locales;
  const typeFilter = options.types ? new Set(options.types) : null;
  const roots = new Set<string>();

  for (const type of project.listTypes()) {
    if (!isRoutableType(type.config)) continue;
    if (typeFilter && !typeFilter.has(type.id)) continue;
    const segment = exportDirSegment(type.config.path!);
    roots.add(`${segment}/`);
    for (const locale of locales) {
      if (locale === config.defaultLocale) continue;
      roots.add(`${locale}/${segment}/`);
    }
  }

  return [...roots].sort();
}

/** Build static raw MDX exports for all routable content types. */
export function buildStaticRawExports(
  project: ScribeProject,
  options: BuildStaticRawExportsOptions = {},
): StaticRawExport[] {
  const { config } = project;
  const extension = normalizeExtension(options.extension ?? ".mdx");
  const locales = options.locales ?? config.locales;
  const excludeRedirected = options.excludeRedirected ?? true;
  const excludeNoindex = options.excludeNoindex ?? false;
  const typeFilter = options.types ? new Set(options.types) : null;

  const out: StaticRawExport[] = [];
  const urlBuilder = createUrlBuilder(config);

  for (const type of project.listTypes()) {
    if (!isRoutableType(type.config)) continue;
    if (typeFilter && !typeFilter.has(type.id)) continue;

    const pathTemplate = type.config.path!;
    const all = type.load();
    const enIdx = all.get(config.defaultLocale);
    if (!enIdx) continue;

    for (const locale of locales) {
      for (const enDoc of enIdx.bySlug.values()) {
        const resolved = type.resolve(enDoc.slug, locale);
        if (!resolved.document) continue;
        if (excludeRedirected && resolved.shouldRedirectTo) continue;
        if (excludeNoindex && resolved.document.noindex) continue;

        const doc = resolved.document;
        const slugWithExt = `${doc.slug}${extension}`;
        const urlPath = urlBuilder.resolvePath(pathTemplate, slugWithExt, locale);

        out.push({
          relativePath: urlPath.slice(1),
          urlPath,
          locale,
          typeId: type.id,
          enSlug: doc.enSlug,
          source: serializeMdx(doc.frontmatter, doc.content),
        });
      }
    }
  }

  return out;
}
