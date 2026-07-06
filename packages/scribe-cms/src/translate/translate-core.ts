import { stripLocaleSuffixFromSlug } from "../core/localized-slug.js";
import type { ContentTypeConfig, ScribeConfig, ScribeDocument } from "../core/types.js";
import { computePageEnHash } from "../hash/page-hash.js";
import { getTranslatablePayload, readEnDocument } from "../loader/create-loader.js";
import { recordEnSnapshot } from "../history/record-snapshot.js";
import { openStore } from "../storage/sqlite.js";
import { getTranslation, upsertTranslation } from "../storage/translations.js";
import type { GeminiTokenUsage } from "./gemini-client.js";
import { estimateTranslationCostUsd, type TranslationCostMode } from "./gemini-pricing.js";
import { DEFAULT_GEMINI_MODEL, normalizeGeminiDisplayName } from "./gemini-models.js";
import { buildPageTranslationPrompt } from "./prompts/translation-prompt.js";
import { buildGeminiResponseSchema } from "./response-schema.js";
import { resolveTranslateConfig } from "./resolve-translate-config.js";
import { assertValidTranslatedMdxBody } from "./validate-mdx-body.js";
import { validateTranslatedFrontmatter } from "./validate-translation.js";
import type { TranslationWorkItem } from "./worklist.js";

export type TranslateMode = "batch" | "direct";

export interface TranslatePageResult {
  contentType: string;
  enSlug: string;
  locale: string;
  skipped: boolean;
  failed?: boolean;
  reason?: "fresh" | "in-flight";
  model?: string;
  usage?: GeminiTokenUsage;
  estimatedCostUsd?: number;
  durationMs?: number;
  error?: string;
  slugAdjusted?: { from: string; to: string; matchedCode: string };
  mdxAdjusted?: boolean;
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
  | {
      type: "start";
      total: number;
      concurrency: number;
      dryRun: boolean;
      model?: string;
      mode?: TranslateMode;
    }
  | { type: "item-start"; item: TranslationWorkItem; active: string[] }
  | { type: "item-done"; result: TranslatePageResult }
  | {
      type: "batch-submitted";
      name: string;
      count: number;
      model?: string;
      jobIndex: number;
      jobCount: number;
      resumed?: boolean;
      /** ISO timestamp of the job's actual submission (persisted created_at). */
      createdAt?: string;
    }
  | {
      type: "batch-polling";
      name: string;
      state: string;
      /** Elapsed since the job was submitted (not since the CLI started). */
      elapsedMs: number;
      jobIndex: number;
      jobCount: number;
    }
  | {
      type: "batch-done";
      name: string;
      state: string;
      model?: string;
      count: number;
      jobIndex: number;
      jobCount: number;
      translated: number;
      failed: number;
      inputTokens: number;
      outputTokens: number;
      estimatedCostUsd: number;
      /** Elapsed since the job was submitted. */
      elapsedMs: number;
      /**
       * True when a concurrent scribe process won the ingestion claim: the
       * job's results were saved by that process, this one has nothing to add.
       */
      alreadyIngested?: boolean;
    }
  | {
      /**
       * Emitted once, after the main pass, when validation failures will be
       * retried. Carries the failed items so reporters can print the recap.
       */
      type: "retry-start";
      failed: TranslatePageResult[];
    }
  | {
      type: "done";
      results: TranslatePageResult[];
      totals: TranslateWorklistTotals;
      /** How many results in `results` succeeded only on the retry round. */
      retriedTranslated?: number;
    };

/** Stable identity for a worklist item / batch item row. */
export function translationItemKey(item: {
  contentType?: string;
  content_type?: string;
  enSlug?: string;
  en_slug?: string;
  locale: string;
}): string {
  const contentType = item.contentType ?? item.content_type ?? "";
  const enSlug = item.enSlug ?? item.en_slug ?? "";
  return `${contentType}\u0000${enSlug}\u0000${item.locale}`;
}

export function summarizeResults(
  results: TranslatePageResult[],
  durationMs: number,
): TranslateWorklistTotals {
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

export function formatTranslateError(error: unknown): string {
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

function resolveContextLabel(enDoc: ScribeDocument, enSlug: string): string {
  const fm = enDoc.frontmatter as Record<string, unknown>;
  for (const key of ["title", "name", "h1"]) {
    const value = fm[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return enSlug;
}

export function baseForItem(
  item: TranslationWorkItem,
): Pick<TranslatePageResult, "contentType" | "enSlug" | "locale"> {
  return {
    contentType: item.contentType,
    enSlug: item.enSlug,
    locale: item.locale,
  };
}

/** Everything needed to submit and finalize one translation request. */
export interface PreparedTranslation {
  item: TranslationWorkItem;
  type: ContentTypeConfig;
  enDoc: ScribeDocument;
  payload: { frontmatter: Record<string, unknown>; body: string };
  currentEnHash: string;
  existingSlug?: string;
  /** Configured model (may be undefined; env/default applies downstream). */
  model?: string;
  prompt: string;
  responseSchema?: Record<string, unknown>;
}

export type PrepareOutcome =
  | { status: "ready"; prepared: PreparedTranslation }
  | { status: "done"; result: TranslatePageResult };

/**
 * Shared pre-flight for the direct and batch paths: read the EN doc, skip when
 * the stored translation is fresh, and build the prompt + response schema.
 * Throws on unrecoverable item errors (unknown type, missing EN doc).
 */
export function prepareTranslation(
  config: ScribeConfig,
  item: TranslationWorkItem,
  options: { model?: string; force?: boolean },
  startedAt: number,
): PrepareOutcome {
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
      status: "done",
      result: {
        ...baseForItem(item),
        skipped: true,
        reason: "fresh",
        durationMs: Date.now() - startedAt,
      },
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
    previousError: item.previousError,
  });

  const responseSchema = buildGeminiResponseSchema(
    type.schema,
    type.slugStrategy,
    payload.frontmatter,
  );

  return {
    status: "ready",
    prepared: {
      item,
      type,
      enDoc,
      payload,
      currentEnHash,
      existingSlug: existing?.slug,
      model,
      prompt,
      responseSchema: responseSchema ?? undefined,
    },
  };
}

/**
 * Shared post-processing for the direct and batch paths: strip locale suffixes
 * from the slug, validate frontmatter + MDX body, snapshot the EN source and
 * upsert the translation. Never throws — failures come back as a failed result.
 * Pass `snapshotId` when the EN snapshot was already recorded (batch submission
 * time) so ingestion does not depend on the current EN files.
 */
export function finalizeTranslation(
  config: ScribeConfig,
  prepared: PreparedTranslation,
  output: {
    model: string;
    parsed: { frontmatter: Record<string, unknown>; body: string; slug?: string };
    usage: GeminiTokenUsage;
  },
  options: { costMode: TranslationCostMode; startedAt: number; snapshotId?: number },
): TranslatePageResult {
  const { item, type, enDoc, payload } = prepared;
  const base = baseForItem(item);

  try {
    const rawSlug =
      type.slugStrategy === "localized"
        ? (output.parsed.slug ?? prepared.existingSlug ?? item.enSlug)
        : item.enSlug;
    const localeCodes = config.locales.filter((l) => l !== config.defaultLocale);
    const { slug, stripped, matchedCode } = stripLocaleSuffixFromSlug(rawSlug, localeCodes);
    const slugAdjusted =
      stripped && matchedCode ? { from: rawSlug, to: slug, matchedCode } : undefined;

    const validated = validateTranslatedFrontmatter(enDoc, output.parsed.frontmatter, type.schema);
    if (!validated.ok) {
      throw new Error(`Translation validation failed: ${validated.error}`);
    }

    const { body: translatedBody, adjusted: mdxAdjusted } = assertValidTranslatedMdxBody(
      output.parsed.body,
    );

    const writeDb = openStore(config, "readwrite");
    const snapshotId =
      options.snapshotId ??
      recordEnSnapshot(
        config,
        {
          contentType: type.id,
          enSlug: item.enSlug,
          enHash: prepared.currentEnHash,
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
      body: translatedBody,
      enHash: prepared.currentEnHash,
      translatedAt: new Date().toISOString(),
      model: output.model,
      snapshotId,
    });
    writeDb.close();

    const estimatedCostUsd = estimateTranslationCostUsd(
      normalizeGeminiDisplayName(output.model),
      output.usage.inputTokens,
      output.usage.outputTokens,
      options.costMode,
    );

    return {
      ...base,
      skipped: false,
      model: output.model,
      usage: output.usage,
      estimatedCostUsd,
      durationMs: Date.now() - options.startedAt,
      slugAdjusted,
      mdxAdjusted: mdxAdjusted || undefined,
    };
  } catch (error) {
    return {
      ...base,
      skipped: false,
      failed: true,
      error: formatTranslateError(error),
      durationMs: Date.now() - options.startedAt,
    };
  }
}

export function displayModelFor(prepared: PreparedTranslation): string {
  return normalizeGeminiDisplayName(
    prepared.model ?? process.env.PROSE_GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL,
  );
}
