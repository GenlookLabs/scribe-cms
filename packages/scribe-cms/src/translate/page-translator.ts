import type { ScribeConfig, ScribeDocument } from "../core/types.js";
import { computePageEnHash } from "../hash/page-hash.js";
import { getTranslatablePayload, readEnDocument } from "../loader/create-loader.js";
import { recordEnSnapshot } from "../history/record-snapshot.js";
import { openStore } from "../storage/sqlite.js";
import { getTranslation, upsertTranslation } from "../storage/translations.js";
import { translatePageWithGemini } from "./gemini-client.js";
import { estimateTranslationCostUsd } from "./gemini-pricing.js";
import { normalizeGeminiDisplayName } from "./gemini-models.js";
import { buildPageTranslationPrompt } from "./prompts/translation-prompt.js";
import { buildGeminiResponseSchema } from "./response-schema.js";
import { resolveTranslateConfig } from "./resolve-translate-config.js";
import { validateTranslatedFrontmatter } from "./validate-translation.js";
import type { TranslationWorkItem } from "./worklist.js";

export interface TranslatePageResult {
  contentType: string;
  enSlug: string;
  locale: string;
  skipped: boolean;
  failed?: boolean;
  reason?: "fresh";
  model?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  estimatedCostUsd?: number;
  durationMs?: number;
  error?: string;
}

export interface TranslateWorklistTotals {
  translated: number;
  skipped: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  durationMs: number;
}

export type TranslateProgressEvent =
  | { type: "start"; total: number; concurrency: number; dryRun: boolean; model?: string }
  | { type: "item-start"; item: TranslationWorkItem; active: string[] }
  | { type: "item-done"; result: TranslatePageResult }
  | { type: "done"; results: TranslatePageResult[]; totals: TranslateWorklistTotals };

function summarizeResults(results: TranslatePageResult[], durationMs: number): TranslateWorklistTotals {
  return results.reduce<TranslateWorklistTotals>(
    (totals, result) => {
      if (result.failed) totals.failed += 1;
      else if (result.skipped) totals.skipped += 1;
      else totals.translated += 1;

      totals.inputTokens += result.usage?.inputTokens ?? 0;
      totals.outputTokens += result.usage?.outputTokens ?? 0;
      totals.estimatedCostUsd += result.estimatedCostUsd ?? 0;
      return totals;
    },
    {
      translated: 0,
      skipped: 0,
      failed: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
      durationMs,
    },
  );
}

function formatTranslateError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  try {
    const parsed = JSON.parse(message) as { error?: { message?: string } };
    if (parsed.error?.message) return parsed.error.message;
  } catch {
    // not JSON
  }
  const embedded = message.match(/"message"\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (embedded?.[1]) {
    return embedded[1].replace(/\\"/g, '"').replace(/\\n/g, "\n");
  }
  return message.length > 160 ? `${message.slice(0, 157)}…` : message;
}

async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      await worker(items[index]!, index);
    }
  });
  await Promise.all(runners);
}

function resolveContextLabel(enDoc: ScribeDocument, enSlug: string): string {
  const fm = enDoc.frontmatter as Record<string, unknown>;
  for (const key of ["title", "name", "h1"]) {
    const value = fm[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return enSlug;
}

/** Translate one locale page via Gemini and upsert into SQLite. */
export async function translatePage(
  config: ScribeConfig,
  item: TranslationWorkItem,
  options: { model?: string; dryRun?: boolean; force?: boolean } = {},
): Promise<TranslatePageResult> {
  const startedAt = Date.now();
  const base = {
    contentType: item.contentType,
    enSlug: item.enSlug,
    locale: item.locale,
  };

  try {
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
        ...base,
        skipped: true,
        reason: "fresh",
        durationMs: Date.now() - startedAt,
      };
    }

    const resolvedTranslate = resolveTranslateConfig(config, type);
    const model = options.model ?? resolvedTranslate.model;

    const prompt = buildPageTranslationPrompt({
      resolved: resolvedTranslate,
      targetLocale: item.locale,
      contextLabel: resolveContextLabel(enDoc, item.enSlug),
      translatableFrontmatter: payload.frontmatter,
      enBody: payload.body,
      slugStrategy: type.slugStrategy,
    });

    if (options.dryRun) {
      return {
        ...base,
        skipped: false,
        model,
        durationMs: Date.now() - startedAt,
      };
    }

    const responseSchema = buildGeminiResponseSchema(type.schema, type.slugStrategy);

    const result = await translatePageWithGemini({
      prompt,
      model,
      responseSchema: responseSchema ?? undefined,
    });
    const slug =
      type.slugStrategy === "localized"
        ? (result.parsed.slug ?? existing?.slug ?? item.enSlug)
        : item.enSlug;

    const validated = validateTranslatedFrontmatter(enDoc, result.parsed.frontmatter, type.schema);
    if (!validated.ok) {
      throw new Error(`Translation validation failed: ${validated.error}`);
    }

    const writeDb = openStore(config, "readwrite");
    const snapshotId = recordEnSnapshot(
      config,
      {
        contentType: type.id,
        enSlug: item.enSlug,
        enHash: currentEnHash,
        frontmatter: payload.frontmatter,
        body: payload.body,
      },
      writeDb,
    );
    upsertTranslation(writeDb, {
      contentType: type.id,
      enSlug: item.enSlug,
      locale: item.locale,
      slug,
      frontmatter: validated.frontmatter,
      body: result.parsed.body,
      enHash: currentEnHash,
      translatedAt: new Date().toISOString(),
      model: result.model,
      snapshotId,
    });
    writeDb.close();

    const estimatedCostUsd = estimateTranslationCostUsd(
      normalizeGeminiDisplayName(result.model),
      result.usage.inputTokens,
      result.usage.outputTokens,
    );

    return {
      ...base,
      skipped: false,
      model: result.model,
      usage: result.usage,
      estimatedCostUsd,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      ...base,
      skipped: false,
      failed: true,
      error: formatTranslateError(error),
      durationMs: Date.now() - startedAt,
    };
  }
}

function labelForItem(item: TranslationWorkItem): string {
  return `${item.contentType}/${item.enSlug}@${item.locale}`;
}

/** Translate a batch of worklist items with bounded concurrency. */
export async function translateWorklist(
  config: ScribeConfig,
  items: TranslationWorkItem[],
  options: {
    model?: string;
    dryRun?: boolean;
    force?: boolean;
    concurrency?: number;
    onProgress?: (event: TranslateProgressEvent) => void;
  } = {},
): Promise<TranslatePageResult[]> {
  const concurrency = Math.max(1, options.concurrency ?? 3);
  const startedAt = Date.now();
  const results: TranslatePageResult[] = new Array(items.length);
  const active = new Set<string>();

  options.onProgress?.({
    type: "start",
    total: items.length,
    concurrency,
    dryRun: Boolean(options.dryRun),
    model: options.model,
  });

  await runPool(items, concurrency, async (item, index) => {
    const label = labelForItem(item);
    active.add(label);
    options.onProgress?.({ type: "item-start", item, active: [...active] });

    const result = await translatePage(config, item, options);
    results[index] = result;

    active.delete(label);
    options.onProgress?.({ type: "item-done", result });
  });

  const totals = summarizeResults(results, Date.now() - startedAt);
  options.onProgress?.({ type: "done", results, totals });
  return results;
}
