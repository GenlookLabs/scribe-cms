import type { ScribeConfig } from "../core/types.js";
import { listBatchItems, type BatchJobRow } from "../storage/batch-jobs.js";
import { openStore } from "../storage/sqlite.js";
import {
  failedResultForItem,
  planBatchJobs,
  pollAndIngestBatchJobs,
  readPendingBatchWork,
  submitBatchJobPlan,
} from "./batch-worklist.js";
import { translatePageWithGemini } from "./gemini-client.js";
import { normalizeGeminiDisplayName, resolveGeminiModelId } from "./gemini-models.js";
import {
  baseForItem,
  displayModelFor,
  finalizeTranslation,
  prepareTranslation,
  summarizeResults,
  translationItemKey,
  type PreparedTranslation,
  type PrepareOutcome,
  type TranslateMode,
  type TranslatePageResult,
  type TranslateProgressEvent,
  type TranslateWorklistTotals,
} from "./translate-core.js";
import type { TranslationWorkItem } from "./worklist.js";

export {
  finalizeTranslation,
  type PreparedTranslation,
  type TranslateMode,
  type TranslatePageResult,
  type TranslateProgressEvent,
  type TranslateWorklistTotals,
};

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

function labelForItem(item: TranslationWorkItem): string {
  return `${item.contentType}/${item.enSlug}@${item.locale}`;
}

/**
 * Translate one locale page via a direct (interactive) Gemini call and upsert
 * into SQLite. Used by the studio server and other single-page callers; the
 * worklist path defaults to the Batch API instead.
 */
export async function translatePage(
  config: ScribeConfig,
  item: TranslationWorkItem,
  options: { model?: string; dryRun?: boolean; force?: boolean } = {},
): Promise<TranslatePageResult> {
  const startedAt = Date.now();

  let outcome: PrepareOutcome;
  try {
    outcome = prepareTranslation(config, item, options, startedAt);
  } catch (error) {
    return failedResultForItem(item, error, startedAt);
  }
  if (outcome.status === "done") return outcome.result;
  const prepared = outcome.prepared;

  if (options.dryRun) {
    return {
      ...baseForItem(item),
      skipped: false,
      model: prepared.model,
      durationMs: Date.now() - startedAt,
    };
  }

  try {
    const result = await translatePageWithGemini({
      prompt: prepared.prompt,
      model: prepared.model,
      responseSchema: prepared.responseSchema,
    });
    return finalizeTranslation(
      config,
      prepared,
      { model: result.model, parsed: result.parsed, usage: result.usage },
      { costMode: "interactive", startedAt },
    );
  } catch (error) {
    return failedResultForItem(item, error, startedAt);
  }
}

interface ResultCollector {
  emit: (result: TranslatePageResult) => void;
  assemble: () => TranslatePageResult[];
}

/**
 * Route results into their input worklist slot (by item identity) so output
 * order matches input; results with no matching input item (resumed jobs from
 * a previous run) are appended after.
 */
function createResultCollector(
  items: TranslationWorkItem[],
  onProgress?: (event: TranslateProgressEvent) => void,
): ResultCollector {
  const slotByKey = new Map<string, number>();
  items.forEach((item, index) => slotByKey.set(translationItemKey(item), index));
  const slots: (TranslatePageResult | undefined)[] = new Array(items.length);
  const extras: TranslatePageResult[] = [];

  return {
    emit(result) {
      const slot = slotByKey.get(translationItemKey(result));
      if (slot !== undefined && slots[slot] === undefined) slots[slot] = result;
      else extras.push(result);
      onProgress?.({ type: "item-done", result });
    },
    assemble() {
      return [
        ...slots.filter((result): result is TranslatePageResult => result !== undefined),
        ...extras,
      ];
    },
  };
}

/**
 * Translate a batch of worklist items. By default the whole worklist goes
 * through the Gemini Batch API (50% token pricing): jobs are planned upfront
 * (grouped by model, chunked by size), submitted together, persisted for
 * resumability, then polled until every job lands. `mode: "direct"` restores
 * the interactive per-page pool (where `concurrency` applies). Any pending
 * jobs from a previous interrupted run are polled and ingested alongside the
 * new work, and their in-flight items are excluded from resubmission.
 */
export async function translateWorklist(
  config: ScribeConfig,
  items: TranslationWorkItem[],
  options: {
    model?: string;
    dryRun?: boolean;
    force?: boolean;
    concurrency?: number;
    mode?: TranslateMode;
    onProgress?: (event: TranslateProgressEvent) => void;
  } = {},
): Promise<TranslatePageResult[]> {
  const mode: TranslateMode = options.mode ?? "batch";
  const concurrency = Math.max(1, options.concurrency ?? 3);
  const startedAt = Date.now();

  // Dry run: report per-item work without touching the API or pending jobs.
  if (options.dryRun) {
    options.onProgress?.({
      type: "start",
      total: items.length,
      concurrency,
      dryRun: true,
      model: options.model,
      mode,
    });
    const results = items.map((item) => {
      const itemStartedAt = Date.now();
      try {
        const outcome = prepareTranslation(config, item, options, itemStartedAt);
        return outcome.status === "done"
          ? outcome.result
          : {
              ...baseForItem(item),
              skipped: false,
              model: outcome.prepared.model,
              durationMs: Date.now() - itemStartedAt,
            };
      } catch (error) {
        return failedResultForItem(item, error, itemStartedAt);
      }
    });
    for (const result of results) options.onProgress?.({ type: "item-done", result });
    const totals = summarizeResults(results, Date.now() - startedAt);
    options.onProgress?.({ type: "done", results, totals });
    return results;
  }

  // Pending jobs from a previous run are polled alongside the new work; their
  // in-flight items are excluded from resubmission (their results arrive when
  // the pending job is ingested).
  const pending = readPendingBatchWork(config);
  const inputKeys = new Set(items.map((item) => translationItemKey(item)));
  const resumedExtraCount = pending.pendingItems.filter(
    (item) => !inputKeys.has(translationItemKey(item)),
  ).length;

  options.onProgress?.({
    type: "start",
    total: items.length + resumedExtraCount,
    concurrency,
    dryRun: false,
    model: options.model,
    mode,
  });

  const collector = createResultCollector(items, options.onProgress);
  const workItems = items.filter((item) => !pending.inFlightKeys.has(translationItemKey(item)));

  if (mode === "direct") {
    const pendingCounts = countPendingItems(config, pending.jobs);
    emitResumedJobs(pending.jobs, pendingCounts, pending.jobs.length, options.onProgress);
    const active = new Set<string>();
    await Promise.all([
      runPool(workItems, concurrency, async (item) => {
        const label = labelForItem(item);
        active.add(label);
        options.onProgress?.({ type: "item-start", item, active: [...active] });
        const result = await translatePage(config, item, options);
        active.delete(label);
        collector.emit(result);
      }),
      pending.jobs.length > 0
        ? pollAndIngestBatchJobs(config, pending.jobs, {
            onProgress: options.onProgress,
            onResult: collector.emit,
          })
        : Promise.resolve(),
    ]);
  } else {
    // Prepare every remaining item; fresh pages skip, broken items fail.
    const entries: Array<{ apiModel: string; prompt: string; prepared: PreparedTranslation }> = [];
    for (const item of workItems) {
      const itemStartedAt = Date.now();
      try {
        const outcome = prepareTranslation(config, item, options, itemStartedAt);
        if (outcome.status === "done") {
          collector.emit(outcome.result);
        } else {
          entries.push({
            apiModel: resolveGeminiModelId(displayModelFor(outcome.prepared)),
            prompt: outcome.prepared.prompt,
            prepared: outcome.prepared,
          });
        }
      } catch (error) {
        collector.emit(failedResultForItem(item, error, itemStartedAt));
      }
    }

    const plans = planBatchJobs(entries);
    const jobCount = pending.jobs.length + plans.length;
    const pendingCounts = countPendingItems(config, pending.jobs);
    emitResumedJobs(pending.jobs, pendingCounts, jobCount, options.onProgress);

    // Submit every job upfront (concurrently), persisting each as soon as its
    // create call returns — Ctrl+C during polling loses nothing.
    const submitted = await Promise.all(
      plans.map(async (plan, planIndex) => {
        try {
          return await submitBatchJobPlan(config, {
            plan,
            displayModel: normalizeGeminiDisplayName(plan.apiModel),
            jobIndex: pending.jobs.length + planIndex,
            jobCount,
            onProgress: options.onProgress,
          });
        } catch (error) {
          for (const entry of plan.entries) {
            collector.emit(failedResultForItem(entry.prepared.item, error, startedAt));
          }
          return undefined;
        }
      }),
    );

    const jobsToPoll: BatchJobRow[] = [
      ...pending.jobs,
      ...submitted.filter((row): row is BatchJobRow => row !== undefined),
    ];
    if (jobsToPoll.length > 0) {
      await pollAndIngestBatchJobs(config, jobsToPoll, {
        jobCount,
        onProgress: options.onProgress,
        onResult: collector.emit,
      });
    }
  }

  const results = collector.assemble();
  const totals = summarizeResults(results, Date.now() - startedAt);
  options.onProgress?.({ type: "done", results, totals });
  return results;
}

function countPendingItems(config: ScribeConfig, jobs: BatchJobRow[]): Map<number, number> {
  if (jobs.length === 0) return new Map();
  const db = openStore(config, "readonly");
  const counts = new Map<number, number>();
  for (const job of jobs) {
    counts.set(job.id, listBatchItems(db, job.id).filter((i) => i.status === "pending").length);
  }
  db.close();
  return counts;
}

function emitResumedJobs(
  jobs: BatchJobRow[],
  counts: Map<number, number>,
  jobCount: number,
  onProgress?: (event: TranslateProgressEvent) => void,
): void {
  jobs.forEach((job, jobIndex) => {
    onProgress?.({
      type: "batch-submitted",
      name: job.job_name,
      count: counts.get(job.id) ?? 0,
      model: job.display_model,
      jobIndex,
      jobCount,
      resumed: true,
      createdAt: job.created_at,
    });
  });
}

/**
 * Poll and ingest pending batch jobs from a previous run without submitting
 * anything new (`scribe translate --resume`). Returns null when there is
 * nothing to resume.
 */
export async function resumeTranslationJobs(
  config: ScribeConfig,
  options: { onProgress?: (event: TranslateProgressEvent) => void } = {},
): Promise<TranslatePageResult[] | null> {
  const startedAt = Date.now();
  const pending = readPendingBatchWork(config);
  if (pending.jobs.length === 0) return null;

  options.onProgress?.({
    type: "start",
    total: pending.pendingItems.length,
    concurrency: 1,
    dryRun: false,
    mode: "batch",
  });
  const counts = countPendingItems(config, pending.jobs);
  emitResumedJobs(pending.jobs, counts, pending.jobs.length, options.onProgress);

  const results: TranslatePageResult[] = [];
  await pollAndIngestBatchJobs(config, pending.jobs, {
    onProgress: options.onProgress,
    onResult: (result) => {
      results.push(result);
      options.onProgress?.({ type: "item-done", result });
    },
  });

  const totals = summarizeResults(results, Date.now() - startedAt);
  options.onProgress?.({ type: "done", results, totals });
  return results;
}
