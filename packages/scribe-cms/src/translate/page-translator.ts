import type { ScribeConfig } from "../core/types.js";
import { computePageEnHash } from "../hash/page-hash.js";
import { getTranslatablePayload, readEnDocument } from "../loader/create-loader.js";
import { recordRevision } from "../history/record-revision.js";
import { openStore } from "../storage/sqlite.js";
import { getTranslation, upsertTranslation } from "../storage/translations.js";
import { translatePageWithGemini } from "./gemini-client.js";
import { buildPageTranslationPrompt } from "./prompts/translation-prompt.js";
import { resolveTranslateConfig } from "./resolve-translate-config.js";
import type { TranslationWorkItem } from "./worklist.js";

export interface TranslatePageResult {
  contentType: string;
  enSlug: string;
  locale: string;
  skipped: boolean;
  reason?: "fresh";
  model?: string;
}

/** Translate one locale page via Gemini and upsert into SQLite. */
export async function translatePage(
  config: ScribeConfig,
  item: TranslationWorkItem,
  options: { model?: string; dryRun?: boolean; force?: boolean } = {},
): Promise<TranslatePageResult> {
  const type = config.types.find((t) => t.id === item.contentType);
  if (!type) throw new Error(`Unknown content type ${item.contentType}`);

  const enDoc = readEnDocument(config, type, item.enSlug);
  if (!enDoc) throw new Error(`EN document not found: ${item.enSlug}`);

  const payload = getTranslatablePayload(enDoc, type);
  const currentEnHash = computePageEnHash(payload.frontmatter, payload.body);

  const db = openStore(config, "readonly");
  const existing = getTranslation(db, type.id, item.enSlug, item.locale);
  db.close();

  if (!options.force && existing && existing.en_hash === currentEnHash) {
    return {
      contentType: item.contentType,
      enSlug: item.enSlug,
      locale: item.locale,
      skipped: true,
      reason: "fresh",
    };
  }

  const resolvedTranslate = resolveTranslateConfig(config, type);

  const prompt = buildPageTranslationPrompt({
    resolved: resolvedTranslate,
    targetLocale: item.locale,
    enTitle: String(enDoc.frontmatter.title ?? item.enSlug),
    enDescription: String(enDoc.frontmatter.description ?? ""),
    translatableFrontmatter: payload.frontmatter,
    enBody: payload.body,
    slugStrategy: type.slugStrategy,
  });

  if (options.dryRun) {
    return {
      contentType: item.contentType,
      enSlug: item.enSlug,
      locale: item.locale,
      skipped: false,
      model: options.model,
    };
  }

  const result = await translatePageWithGemini({
    prompt,
    model: options.model ?? resolvedTranslate.model,
  });
  const slug =
    type.slugStrategy === "localized"
      ? (result.parsed.slug ?? existing?.slug ?? item.enSlug)
      : item.enSlug;

  const writeDb = openStore(config, "readwrite");
  upsertTranslation(writeDb, {
    contentType: type.id,
    enSlug: item.enSlug,
    locale: item.locale,
    slug,
    frontmatter: result.parsed.frontmatter,
    body: result.parsed.body,
    enHash: currentEnHash,
    translatedAt: new Date().toISOString(),
    model: result.model,
  });
  writeDb.close();

  recordRevision(config, {
    contentType: type.id,
    enSlug: item.enSlug,
    locale: item.locale,
    revisionKind: "translation",
    enHash: currentEnHash,
    body: result.parsed.body,
    model: result.model,
  });

  return {
    contentType: item.contentType,
    enSlug: item.enSlug,
    locale: item.locale,
    skipped: false,
    model: result.model,
  };
}

/** Translate a batch of worklist items sequentially. */
export async function translateWorklist(
  config: ScribeConfig,
  items: TranslationWorkItem[],
  options: { model?: string; dryRun?: boolean; force?: boolean; concurrency?: number } = {},
): Promise<TranslatePageResult[]> {
  const results: TranslatePageResult[] = [];
  for (const item of items) {
    results.push(await translatePage(config, item, options));
  }
  return results;
}
