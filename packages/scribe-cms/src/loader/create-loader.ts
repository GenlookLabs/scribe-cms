import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import type { z } from "zod";
import {
  extractBuiltinEnFields,
  mergeBuiltinsIntoFrontmatter,
  seoFieldsFromEn,
} from "../core/builtin-fields.js";
import {
  listAssetFields,
  mergeStructuralOntoLocale,
  pickTranslatable,
  type SchemaFieldMeta,
} from "../core/introspect-schema.js";
import type {
  AllDocuments,
  ContentTypeConfig,
  LocaleIndex,
  ScribeConfig,
  ScribeDocument,
} from "../core/types.js";
import { openStore, resolveStorePath } from "../storage/sqlite.js";
import { listTranslationsForType } from "../storage/translations.js";
import { prepareTranslatedMdxBody } from "../translate/validate-mdx-body.js";
import { isPublishableContentFile, normalizeEnFrontmatter } from "./normalize-en.js";
import { resolveDocumentAssets } from "./resolve-assets.js";

function isPostFile(name: string): boolean {
  return isPublishableContentFile(name);
}

function listEnFiles(contentDir: string): string[] {
  if (!fs.existsSync(contentDir)) return [];
  return fs
    .readdirSync(contentDir)
    .filter(isPostFile)
    .map((f) => path.join(contentDir, f));
}

function slugFromPath(filePath: string): string {
  return path.basename(filePath).replace(/\.(md|mdx)$/, "");
}

export interface ParseEnResult {
  document: ScribeDocument | null;
  issues: Array<{ field: string; message: string; level: "error" | "warning" }>;
}

export function parseEnMdx(
  filePath: string,
  config: ScribeConfig,
  type: ContentTypeConfig,
): ParseEnResult {
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = matter(raw);
  const slug = slugFromPath(filePath);
  const normalized = normalizeEnFrontmatter(parsed.data as Record<string, unknown>);
  const { builtin, rest, issues: builtinIssues } = extractBuiltinEnFields(
    normalized,
    type.path,
    slug,
    config.defaultLocale,
  );
  const issues = builtinIssues.map((issue) => ({
    field: issue.field,
    message: issue.message,
    level: issue.level,
  }));

  const result = type.schema.safeParse(rest);
  if (!result.success) {
    return {
      document: null,
      issues: [
        ...issues,
        ...result.error.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
          level: "error" as const,
        })),
      ],
    };
  }

  if (issues.some((i) => i.level === "error")) {
    return { document: null, issues };
  }

  const frontmatter = mergeBuiltinsIntoFrontmatter(
    result.data as Record<string, unknown>,
    {
      publishedAt: builtin.publishedAt,
      updatedAt: builtin.updatedAt,
      noindex: builtin.noindex,
      canonicalPathOverride: builtin.canonicalPathOverride,
      slug,
      locale: config.defaultLocale,
    },
    type,
    config.defaultLocale,
    config.localeRouting,
  );

  const crossIssues = type.crossValidate?.(result.data as z.infer<typeof type.schema>, {
    locale: config.defaultLocale,
    defaultLocale: config.defaultLocale,
    slug,
    enSlug: slug,
    knownLocales: config.locales,
  }) ?? [];
  issues.push(...crossIssues);

  const document: ScribeDocument = {
    slug,
    enSlug: slug,
    locale: config.defaultLocale,
    publishedAt: builtin.publishedAt,
    updatedAt: builtin.updatedAt,
    noindex: builtin.noindex,
    canonicalPathOverride: builtin.canonicalPathOverride,
    frontmatter,
    // Bodyless types (`body: false`) never carry a body: the loader skips the
    // MDX body entirely so runtimes, exports, and hashing all see an empty body.
    // A stray body is reported separately by `scribe validate`.
    content: type.body === false ? "" : parsed.content,
    filePath,
  };

  return { document, issues };
}

function buildDocumentFromTranslation(
  row: {
    slug: string;
    en_slug: string;
    locale: string;
    frontmatter_json: string;
    body: string;
  },
  enDoc: ScribeDocument,
  type: ContentTypeConfig,
  config: ScribeConfig,
): ScribeDocument {
  const localeFm = JSON.parse(row.frontmatter_json) as Record<string, unknown>;
  const merged = mergeStructuralOntoLocale(localeFm, enDoc.frontmatter, type.schema);
  const seo = seoFieldsFromEn(enDoc);
  const frontmatter = mergeBuiltinsIntoFrontmatter(
    merged,
    { ...seo, slug: row.slug, locale: row.locale },
    type,
    config.defaultLocale,
    config.localeRouting,
  );

  return {
    slug: row.slug,
    enSlug: row.en_slug,
    locale: row.locale,
    publishedAt: seo.publishedAt,
    updatedAt: seo.updatedAt,
    noindex: seo.noindex,
    canonicalPathOverride: seo.canonicalPathOverride,
    frontmatter,
    content: prepareTranslatedMdxBody(row.body).body,
  };
}

const DEV_REVALIDATE_MS = 1500;

/**
 * Package-internal monotonic content version. A mutation that writes/removes
 * content files (currently only entry deletion) bumps this so every loader
 * treats its cached document list as stale immediately, bypassing the dev
 * revalidation window. Not exported from the package's public entrypoint.
 */
let contentVersion = 0;

/** Invalidate every content loader's cache after an in-process content mutation. */
export function bumpContentVersion(): void {
  contentVersion++;
}

export function createContentLoader(
  config: ScribeConfig,
  type: ContentTypeConfig,
  options: { resolveAssets?: boolean } = {},
): () => AllDocuments {
  let cached: AllDocuments | null = null;
  let signature = "";
  let lastCheck = 0;
  let builtVersion = contentVersion;
  const contentDir = path.join(/* turbopackIgnore: true */ config.rootDir, type.contentDir);
  const storePath = resolveStorePath(config);
  const isProd = process.env.NODE_ENV === "production";

  // Asset resolution is a runtime read-path concern (createScribe only); the CLI,
  // validation, and static exports build the project without it and see source values.
  const assets = config.assets;
  const assetFields: SchemaFieldMeta[] =
    assets && options.resolveAssets ? listAssetFields(type.schema) : [];
  const resolveAssets = (doc: ScribeDocument): void => {
    if (assetFields.length > 0 && assets) resolveDocumentAssets(doc, assetFields, assets);
  };

  function computeSignature(): string {
    const files = listEnFiles(contentDir);
    let newest = 0;
    for (const f of files) {
      try {
        newest = Math.max(newest, fs.statSync(f).mtimeMs);
      } catch {
        /* ignore */
      }
    }
    let store = 0;
    try {
      store = fs.statSync(storePath).mtimeMs;
    } catch {
      /* ignore */
    }
    return `${files.length}:${newest}:${store}`;
  }

  function build(): AllDocuments {
    const out = new Map<string, LocaleIndex>();
    const englishBySlug = new Map<string, ScribeDocument>();

    for (const file of listEnFiles(contentDir)) {
      const { document, issues } = parseEnMdx(file, config, type);
      if (document) {
        englishBySlug.set(document.slug, document);
        if (issues.length > 0) {
          for (const issue of issues) {
            console.warn(
              `[scribe:${type.id}] ${file} ${issue.level}: ${issue.field}: ${issue.message}`,
            );
          }
        }
      } else {
        console.warn(
          `[scribe:${type.id}] Skipping ${file} — validation failed:\n` +
            issues.map((i) => `  - ${i.field}: ${i.message}`).join("\n"),
        );
      }
    }

    out.set(config.defaultLocale, {
      bySlug: englishBySlug,
      byEnSlug: englishBySlug,
    });

    const db = openStore(config, "readonly");
    const rows = listTranslationsForType(db, type.id);
    db.close();

    const rowsByLocale = new Map<string, typeof rows>();
    for (const row of rows) {
      const list = rowsByLocale.get(row.locale) ?? [];
      list.push(row);
      rowsByLocale.set(row.locale, list);
    }

    for (const locale of config.locales) {
      if (locale === config.defaultLocale) continue;
      const bySlug = new Map<string, ScribeDocument>();
      const byEnSlug = new Map<string, ScribeDocument>();
      for (const row of rowsByLocale.get(locale) ?? []) {
        const enDoc = englishBySlug.get(row.en_slug);
        if (!enDoc) continue;
        // Merge structural (incl. asset) fields from the *unresolved* EN source,
        // then resolve the locale doc's own fresh frontmatter.
        const doc = buildDocumentFromTranslation(row, enDoc, type, config);
        resolveAssets(doc);
        bySlug.set(doc.slug, doc);
        byEnSlug.set(row.en_slug, doc);
      }
      out.set(locale, { bySlug, byEnSlug });
    }

    // Resolve EN docs last: locale docs merged from their unresolved frontmatter above.
    for (const doc of englishBySlug.values()) resolveAssets(doc);

    return out;
  }

  return () => {
    if (cached) {
      // An in-process content mutation (e.g. entry deletion) forces an
      // unconditional rebuild regardless of prod mode or the dev window.
      if (contentVersion !== builtVersion) {
        cached = build();
        builtVersion = contentVersion;
        lastCheck = Date.now();
        signature = isProd ? "" : computeSignature();
        return cached;
      }
      if (isProd) return cached;
      const now = Date.now();
      if (now - lastCheck < DEV_REVALIDATE_MS) return cached;
      lastCheck = now;
      const sig = computeSignature();
      if (sig === signature) return cached;
      cached = build();
      signature = sig;
      return cached;
    }
    lastCheck = Date.now();
    cached = build();
    builtVersion = contentVersion;
    signature = isProd ? "" : computeSignature();
    return cached;
  };
}

export function readEnDocument(
  config: ScribeConfig,
  type: ContentTypeConfig,
  enSlug: string,
): ScribeDocument | null {
  const contentDir = path.join(/* turbopackIgnore: true */ config.rootDir, type.contentDir);
  for (const ext of [".mdx", ".md"]) {
    const filePath = path.join(contentDir, `${enSlug}${ext}`);
    if (!fs.existsSync(filePath)) continue;
    const { document } = parseEnMdx(filePath, config, type);
    return document;
  }
  return null;
}

export function getTranslatablePayload(
  doc: ScribeDocument,
  type: ContentTypeConfig,
): { frontmatter: Record<string, unknown>; body: string } {
  return {
    frontmatter: pickTranslatable(doc.frontmatter, type.schema),
    // Bodyless types never contribute a body to any translation payload, hash,
    // or snapshot — regardless of what a document's `content` happens to hold.
    body: type.body === false ? "" : doc.content,
  };
}
