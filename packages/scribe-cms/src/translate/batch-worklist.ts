import type { BatchJob } from "@google/genai";
import type { ScribeConfig, ScribeDocument } from "../core/types.js";
import { readEnDocument } from "../loader/create-loader.js";
import { recordEnSnapshot } from "../history/record-snapshot.js";
import {
  insertBatchItems,
  insertBatchJob,
  listBatchItems,
  listPendingBatchItems,
  listPendingBatchJobs,
  updateBatchItemStatus,
  updateBatchJobState,
  type BatchItemRow,
  type BatchJobRow,
} from "../storage/batch-jobs.js";
import { openStore } from "../storage/sqlite.js";
import { getEnSnapshot, getTranslation } from "../storage/translations.js";
import {
  createGeminiBatchJob,
  getGeminiBatchJob,
  isSuccessfulBatchState,
  isTerminalBatchState,
  textFromBatchResponse,
} from "./gemini-batch.js";
import { buildGeminiRequestConfig, parseGeminiResponse, usageFromResponse } from "./gemini-client.js";
import {
  baseForItem,
  finalizeTranslation,
  formatTranslateError,
  translationItemKey,
  type PreparedTranslation,
  type TranslatePageResult,
  type TranslateProgressEvent,
} from "./translate-core.js";
import type { TranslationWorkItem } from "./worklist.js";

// The Gemini Batch API caps inline (non-file) submissions at 20MB of request
// payload per job; the SDK types expose no explicit request-count limit. Stay
// conservative: chunk at 100 requests or ~15MB of prompt text per job,
// whichever comes first, leaving headroom for JSON envelope + schemas.
export const MAX_REQUESTS_PER_JOB = 100;
export const MAX_PROMPT_BYTES_PER_JOB = 15 * 1024 * 1024;

const INITIAL_POLL_MS = 5_000;
const MAX_POLL_MS = 30_000;
const POLL_BACKOFF_FACTOR = 1.5;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface BatchPlanEntry {
  apiModel: string;
  prompt: string;
}

export interface BatchJobPlan<T extends BatchPlanEntry> {
  apiModel: string;
  entries: T[];
}

/**
 * Group entries by API model, then chunk each group by request count and total
 * prompt bytes so every plan fits in one inline batch job.
 */
export function planBatchJobs<T extends BatchPlanEntry>(entries: T[]): BatchJobPlan<T>[] {
  const byModel = new Map<string, T[]>();
  for (const entry of entries) {
    const group = byModel.get(entry.apiModel);
    if (group) group.push(entry);
    else byModel.set(entry.apiModel, [entry]);
  }

  const plans: BatchJobPlan<T>[] = [];
  for (const [apiModel, group] of byModel) {
    let current: T[] = [];
    let currentBytes = 0;
    for (const entry of group) {
      const size = Buffer.byteLength(entry.prompt, "utf8");
      if (
        current.length > 0 &&
        (current.length >= MAX_REQUESTS_PER_JOB || currentBytes + size > MAX_PROMPT_BYTES_PER_JOB)
      ) {
        plans.push({ apiModel, entries: current });
        current = [];
        currentBytes = 0;
      }
      current.push(entry);
      currentBytes += size;
    }
    if (current.length > 0) plans.push({ apiModel, entries: current });
  }
  return plans;
}

export interface PendingBatchWork {
  jobs: BatchJobRow[];
  /** translationItemKey() of every request still in flight. */
  inFlightKeys: Set<string>;
  pendingItems: BatchItemRow[];
}

/**
 * Load non-completed batch jobs and their in-flight items from the store.
 * Opens the store readwrite so migrations run before the new tables are read.
 */
export function readPendingBatchWork(config: ScribeConfig): PendingBatchWork {
  const db = openStore(config, "readwrite");
  const jobs = listPendingBatchJobs(db);
  const pendingItems = listPendingBatchItems(db);
  db.close();
  const inFlightKeys = new Set(pendingItems.map((item) => translationItemKey(item)));
  return { jobs, inFlightKeys, pendingItems };
}

export interface SubmitPlanInput<T extends BatchPlanEntry & { prepared: PreparedTranslation }> {
  plan: BatchJobPlan<T>;
  displayModel: string;
  jobIndex: number;
  jobCount: number;
  onProgress?: (event: TranslateProgressEvent) => void;
}

/**
 * Submit one planned job and persist it (job row + item rows + EN snapshots)
 * immediately, before any polling starts, so an interrupt loses nothing.
 */
export async function submitBatchJobPlan<
  T extends BatchPlanEntry & { prepared: PreparedTranslation },
>(config: ScribeConfig, input: SubmitPlanInput<T>): Promise<BatchJobRow> {
  const { plan, displayModel, jobIndex, jobCount } = input;
  const job = await createGeminiBatchJob({
    model: plan.apiModel,
    requests: plan.entries.map(({ prepared }) => ({
      contents: prepared.prompt,
      config: buildGeminiRequestConfig({
        apiModelId: plan.apiModel,
        responseSchema: prepared.responseSchema,
      }),
    })),
    displayName: `scribe-translate-${new Date().toISOString().replace(/[:.]/g, "-")}-${jobIndex + 1}`,
  });

  const createdAt = new Date().toISOString();
  const db = openStore(config, "readwrite");
  const jobId = insertBatchJob(db, {
    jobName: job.name!,
    model: plan.apiModel,
    displayModel,
    state: String(job.state ?? "JOB_STATE_PENDING"),
    createdAt,
  });
  insertBatchItems(
    db,
    jobId,
    plan.entries.map(({ prepared }, requestIndex) => ({
      requestIndex,
      contentType: prepared.item.contentType,
      enSlug: prepared.item.enSlug,
      locale: prepared.item.locale,
      enHash: prepared.currentEnHash,
      // Snapshot the EN source now so ingestion after a resume does not depend
      // on the EN files still matching (or existing) on disk.
      snapshotId: recordEnSnapshot(
        config,
        {
          contentType: prepared.item.contentType,
          enSlug: prepared.item.enSlug,
          enHash: prepared.currentEnHash,
          frontmatter: prepared.payload.frontmatter,
          body: prepared.payload.body,
        },
        db,
      ),
    })),
  );
  const row: BatchJobRow = {
    id: jobId,
    job_name: job.name!,
    model: plan.apiModel,
    display_model: displayModel,
    created_at: createdAt,
    state: String(job.state ?? "JOB_STATE_PENDING"),
    completed_at: null,
  };
  db.close();

  input.onProgress?.({
    type: "batch-submitted",
    name: job.name!,
    count: plan.entries.length,
    model: displayModel,
    jobIndex,
    jobCount,
  });
  return row;
}

/** The subset of a Gemini BatchJob that ingestion needs (test-friendly). */
export interface BatchJobResultLike {
  state?: string;
  error?: { message?: string };
  dest?: { inlinedResponses?: Array<{ response?: unknown; error?: { message?: string } }> };
}

/**
 * Reconstruct a finalize-ready context from a persisted batch item. Prefers the
 * EN doc on disk (for structural frontmatter merging); falls back to the stored
 * EN snapshot when the file is gone.
 */
function buildIngestContext(
  config: ScribeConfig,
  db: ReturnType<typeof openStore>,
  jobRow: BatchJobRow,
  itemRow: BatchItemRow,
): PreparedTranslation {
  const type = config.types.find((t) => t.id === itemRow.content_type);
  if (!type) throw new Error(`Unknown content type ${itemRow.content_type}`);

  let enDoc: ScribeDocument | null = readEnDocument(config, type, itemRow.en_slug);
  if (!enDoc) {
    const snapshot = getEnSnapshot(db, itemRow.snapshot_id);
    if (!snapshot) {
      throw new Error(
        `EN document and snapshot #${itemRow.snapshot_id} not found for ${itemRow.en_slug}`,
      );
    }
    enDoc = {
      slug: itemRow.en_slug,
      enSlug: itemRow.en_slug,
      locale: config.defaultLocale,
      noindex: false,
      frontmatter: JSON.parse(snapshot.frontmatter_json) as Record<string, unknown>,
      content: snapshot.body,
    };
  }

  const item: TranslationWorkItem = {
    contentType: itemRow.content_type,
    enSlug: itemRow.en_slug,
    locale: itemRow.locale,
    reason: "missing",
    currentEnHash: itemRow.en_hash,
  };
  return {
    item,
    type,
    enDoc,
    // Unused on ingest: finalizeTranslation receives the pre-recorded snapshotId.
    payload: { frontmatter: enDoc.frontmatter as Record<string, unknown>, body: enDoc.content },
    currentEnHash: itemRow.en_hash,
    existingSlug: getTranslation(db, type.id, itemRow.en_slug, itemRow.locale)?.slug,
    model: jobRow.display_model,
    prompt: "",
    responseSchema: undefined,
  };
}

/**
 * Ingest a terminal batch job: run every pending item through the shared
 * finalize path (or mark it failed), update item statuses, and mark the job
 * completed. Returns one result per pending item.
 */
export function ingestBatchJob(
  config: ScribeConfig,
  jobRow: BatchJobRow,
  batchJob: BatchJobResultLike,
  onResult?: (result: TranslatePageResult) => void,
): TranslatePageResult[] {
  const state = String(batchJob.state ?? "UNKNOWN");
  const db = openStore(config, "readwrite");
  const pendingItems = listBatchItems(db, jobRow.id).filter((item) => item.status === "pending");
  const results: TranslatePageResult[] = [];

  const failItem = (itemRow: BatchItemRow, message: string, startedAt: number): void => {
    const result: TranslatePageResult = {
      contentType: itemRow.content_type,
      enSlug: itemRow.en_slug,
      locale: itemRow.locale,
      skipped: false,
      failed: true,
      error: formatTranslateError(new Error(message)),
      durationMs: Date.now() - startedAt,
    };
    updateBatchItemStatus(db, jobRow.id, itemRow.request_index, "failed", result.error);
    results.push(result);
    onResult?.(result);
  };

  if (isSuccessfulBatchState(state)) {
    const responses = batchJob.dest?.inlinedResponses ?? [];
    for (const itemRow of pendingItems) {
      const startedAt = Date.now();
      const inlined = responses[itemRow.request_index];
      if (!inlined || inlined.error || !inlined.response) {
        failItem(
          itemRow,
          inlined?.error?.message ??
            (inlined ? "Batch response missing content" : "Batch response missing"),
          startedAt,
        );
        continue;
      }
      let result: TranslatePageResult;
      try {
        const response = inlined.response as Parameters<typeof usageFromResponse>[0];
        const raw = textFromBatchResponse(response);
        const parsed = parseGeminiResponse(raw);
        if (!parsed.frontmatter || typeof parsed.body !== "string") {
          throw new Error("Gemini response missing frontmatter/body");
        }
        const prepared = buildIngestContext(config, db, jobRow, itemRow);
        result = finalizeTranslation(
          config,
          prepared,
          { model: jobRow.display_model, parsed, usage: usageFromResponse(response) },
          { costMode: "batch", startedAt, snapshotId: itemRow.snapshot_id },
        );
      } catch (error) {
        failItem(itemRow, error instanceof Error ? error.message : String(error), startedAt);
        continue;
      }
      updateBatchItemStatus(
        db,
        jobRow.id,
        itemRow.request_index,
        result.failed ? "failed" : "done",
        result.error,
      );
      results.push(result);
      onResult?.(result);
    }
  } else {
    // FAILED / CANCELLED / EXPIRED: every in-flight item fails with the job error.
    const message = batchJob.error?.message ?? `Batch job ended in state ${state}`;
    const startedAt = Date.now();
    for (const itemRow of pendingItems) {
      failItem(itemRow, message, startedAt);
    }
  }

  updateBatchJobState(db, jobRow.id, state, new Date().toISOString());
  db.close();
  return results;
}

/**
 * Poll every tracked job together and ingest each one the moment it reaches a
 * terminal state — no job waits for another. The first status check happens
 * immediately so already-finished jobs (resume) ingest without delay.
 */
export async function pollAndIngestBatchJobs(
  config: ScribeConfig,
  jobs: BatchJobRow[],
  options: {
    jobCount?: number;
    onProgress?: (event: TranslateProgressEvent) => void;
    onResult?: (result: TranslatePageResult) => void;
  } = {},
): Promise<void> {
  const jobCount = options.jobCount ?? jobs.length;
  const active = jobs.map((row, jobIndex) => ({ row, jobIndex }));
  const startedAt = Date.now();
  let delay = INITIAL_POLL_MS;
  let firstRound = true;

  while (active.length > 0) {
    if (!firstRound) {
      await sleep(delay);
      delay = Math.min(delay * POLL_BACKOFF_FACTOR, MAX_POLL_MS);
    }
    firstRound = false;

    for (const tracked of [...active]) {
      const batchJob: BatchJob = await getGeminiBatchJob({ name: tracked.row.job_name });
      const state = String(batchJob.state ?? "UNKNOWN");
      options.onProgress?.({
        type: "batch-polling",
        name: tracked.row.job_name,
        state,
        elapsedMs: Date.now() - startedAt,
        jobIndex: tracked.jobIndex,
        jobCount,
      });
      if (isTerminalBatchState(batchJob.state)) {
        active.splice(active.indexOf(tracked), 1);
        ingestBatchJob(config, tracked.row, batchJob as BatchJobResultLike, options.onResult);
      }
    }
  }
}

/** Result shape helper for items that never reached submission. */
export function failedResultForItem(
  item: TranslationWorkItem,
  error: unknown,
  startedAt: number,
): TranslatePageResult {
  return {
    ...baseForItem(item),
    skipped: false,
    failed: true,
    error: formatTranslateError(error),
    durationMs: Date.now() - startedAt,
  };
}
