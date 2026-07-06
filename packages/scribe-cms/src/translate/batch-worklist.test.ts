import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { field } from "../core/field.js";
import type { ContentTypeConfig, ScribeConfig } from "../core/types.js";
import {
  insertBatchItems,
  insertBatchJob,
  listBatchItems,
  listPendingBatchJobs,
  type BatchJobRow,
} from "../storage/batch-jobs.js";
import { openStore } from "../storage/sqlite.js";
import { getOrCreateEnSnapshot, getTranslation } from "../storage/translations.js";
import {
  MAX_PROMPT_BYTES_PER_JOB,
  MAX_REQUESTS_PER_JOB,
  ingestBatchJob,
  planBatchJobs,
  readPendingBatchWork,
} from "./batch-worklist.js";
import { translationItemKey, type TranslatePageResult } from "./translate-core.js";
import type { TranslationWorkItem } from "./worklist.js";

const blogSchema = z.object({
  title: field.translatable(z.string().min(1)),
});

function makeFixture() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-batchjob-test-"));
  const type: ContentTypeConfig = {
    id: "blog",
    schema: blogSchema,
    contentDir: "blog",
    label: "Blog",
    slugStrategy: "localized",
    indexFallback: "none",
  };
  const config: ScribeConfig = {
    rootDir: tmpDir,
    storePath: path.join(tmpDir, "store.sqlite"),
    locales: ["en", "fr", "ru"],
    defaultLocale: "en",
    localeRouting: { strategy: "path-prefix" },
    types: [type],
  };
  // Create the store (runs migrations for the batch tables).
  openStore(config, "readwrite").close();
  return { config };
}

/** Persist one batch job with fr + ru items for the same EN page. */
function persistJob(config: ScribeConfig): { jobRow: BatchJobRow; jobId: number } {
  const db = openStore(config, "readwrite");
  const snapshotId = getOrCreateEnSnapshot(db, {
    contentType: "blog",
    enSlug: "hello-world",
    enHash: "hash-1",
    frontmatter: { title: "Hello world" },
    body: "Hello, this is the body.",
    createdAt: new Date().toISOString(),
  });
  const createdAt = new Date().toISOString();
  const jobId = insertBatchJob(db, {
    jobName: "batches/test-job-1",
    model: "gemini-3.1-pro-preview",
    displayModel: "gemini-3.1-pro",
    state: "JOB_STATE_PENDING",
    createdAt,
  });
  insertBatchItems(db, jobId, [
    { requestIndex: 0, contentType: "blog", enSlug: "hello-world", locale: "fr", enHash: "hash-1", snapshotId },
    { requestIndex: 1, contentType: "blog", enSlug: "hello-world", locale: "ru", enHash: "hash-1", snapshotId },
  ]);
  db.close();
  const jobRow: BatchJobRow = {
    id: jobId,
    job_name: "batches/test-job-1",
    model: "gemini-3.1-pro-preview",
    display_model: "gemini-3.1-pro",
    created_at: createdAt,
    state: "JOB_STATE_PENDING",
    completed_at: null,
  };
  return { jobRow, jobId };
}

function successResponse(payload: Record<string, unknown>, tokens = 100) {
  return {
    response: {
      candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }],
      usageMetadata: {
        promptTokenCount: tokens,
        candidatesTokenCount: tokens,
        thoughtsTokenCount: 10,
        totalTokenCount: tokens * 2 + 10,
      },
    },
  };
}

describe("planBatchJobs", () => {
  it("groups by model and chunks by request count", () => {
    const entries = Array.from({ length: MAX_REQUESTS_PER_JOB * 2 + 10 }, (_, i) => ({
      apiModel: "gemini-3.1-pro-preview",
      prompt: `prompt ${i}`,
    }));
    const plans = planBatchJobs(entries);
    assert.equal(plans.length, 3);
    assert.deepEqual(
      plans.map((plan) => plan.entries.length),
      [MAX_REQUESTS_PER_JOB, MAX_REQUESTS_PER_JOB, 10],
    );
  });

  it("splits models into separate jobs", () => {
    const plans = planBatchJobs([
      { apiModel: "gemini-3.1-pro-preview", prompt: "a" },
      { apiModel: "gemini-2.5-pro", prompt: "b" },
      { apiModel: "gemini-3.1-pro-preview", prompt: "c" },
    ]);
    assert.equal(plans.length, 2);
    const byModel = new Map(plans.map((plan) => [plan.apiModel, plan.entries.length]));
    assert.equal(byModel.get("gemini-3.1-pro-preview"), 2);
    assert.equal(byModel.get("gemini-2.5-pro"), 1);
  });

  it("chunks by total prompt bytes", () => {
    const bigPrompt = "x".repeat(Math.ceil(MAX_PROMPT_BYTES_PER_JOB * 0.6));
    const plans = planBatchJobs([
      { apiModel: "gemini-3.1-pro-preview", prompt: bigPrompt },
      { apiModel: "gemini-3.1-pro-preview", prompt: bigPrompt },
      { apiModel: "gemini-3.1-pro-preview", prompt: "small" },
    ]);
    // 0.6 + 0.6 > 1.0 budget, so the second big prompt starts a new job; the
    // small one fits alongside it.
    assert.equal(plans.length, 2);
    assert.equal(plans[0]!.entries.length, 1);
    assert.equal(plans[1]!.entries.length, 2);
  });
});

describe("ingestBatchJob (persistence round-trip)", () => {
  it("finalizes successful responses, fails bad ones, updates statuses and completes the job", () => {
    const { config } = makeFixture();
    const { jobRow, jobId } = persistJob(config);

    const results: TranslatePageResult[] = [];
    const returned = ingestBatchJob(
      config,
      jobRow,
      {
        state: "JOB_STATE_SUCCEEDED",
        dest: {
          inlinedResponses: [
            successResponse({
              frontmatter: { title: "Bonjour le monde" },
              body: "Bonjour, voici le corps.",
              slug: "bonjour-le-monde",
            }),
            { error: { message: "request blocked" } },
          ],
        },
      },
      (result) => results.push(result),
    );

    assert.equal(returned.length, 2);
    assert.deepEqual(returned, results);

    const fr = returned.find((r) => r.locale === "fr")!;
    assert.equal(fr.failed, undefined);
    assert.equal(fr.usage?.outputTokens, 110); // candidates + thoughts
    const ru = returned.find((r) => r.locale === "ru")!;
    assert.equal(ru.failed, true);
    assert.match(ru.error ?? "", /request blocked/);

    const db = openStore(config, "readonly");
    const row = getTranslation(db, "blog", "hello-world", "fr");
    assert.ok(row);
    assert.equal(row.slug, "bonjour-le-monde");
    assert.equal(row.en_hash, "hash-1");
    assert.ok(row.snapshot_id); // pre-recorded snapshot reused, not re-recorded

    const items = listBatchItems(db, jobId);
    assert.equal(items.find((i) => i.locale === "fr")?.status, "done");
    assert.equal(items.find((i) => i.locale === "ru")?.status, "failed");

    const pendingJobs = listPendingBatchJobs(db);
    db.close();
    assert.equal(pendingJobs.length, 0, "job must be marked completed");
  });

  it("uses the stored EN snapshot when the EN file is missing on disk", () => {
    // makeFixture never writes EN files, so this whole suite exercises the
    // snapshot fallback; this test asserts it explicitly for a fresh job.
    const { config } = makeFixture();
    const { jobRow } = persistJob(config);
    const [fr] = ingestBatchJob(config, jobRow, {
      state: "JOB_STATE_SUCCEEDED",
      dest: {
        inlinedResponses: [
          successResponse({ frontmatter: { title: "Bonjour" }, body: "Corps.", slug: "bonjour" }),
          { error: { message: "skip" } },
        ],
      },
    });
    assert.equal(fr!.failed, undefined);
    assert.equal(fr!.locale, "fr");
  });

  it("marks every pending item failed when the job itself failed", () => {
    const { config } = makeFixture();
    const { jobRow, jobId } = persistJob(config);

    const returned = ingestBatchJob(config, jobRow, {
      state: "JOB_STATE_FAILED",
      error: { message: "quota exceeded" },
    });

    assert.equal(returned.length, 2);
    assert.ok(returned.every((result) => result.failed));
    assert.match(returned[0]!.error ?? "", /quota exceeded/);

    const db = openStore(config, "readonly");
    const items = listBatchItems(db, jobId);
    assert.ok(items.every((item) => item.status === "failed"));
    const pendingJobs = listPendingBatchJobs(db);
    db.close();
    assert.equal(pendingJobs.length, 0, "failed job must not block future runs");
  });
});

describe("readPendingBatchWork (resume filtering)", () => {
  it("exposes in-flight item keys so new worklists can exclude them", () => {
    const { config } = makeFixture();
    persistJob(config);

    const pending = readPendingBatchWork(config);
    assert.equal(pending.jobs.length, 1);
    assert.equal(pending.pendingItems.length, 2);

    const inFlightFr: TranslationWorkItem = {
      contentType: "blog",
      enSlug: "hello-world",
      locale: "fr",
      reason: "missing",
      currentEnHash: "hash-1",
    };
    const fresh: TranslationWorkItem = { ...inFlightFr, enSlug: "another-page" };

    assert.equal(pending.inFlightKeys.has(translationItemKey(inFlightFr)), true);
    assert.equal(pending.inFlightKeys.has(translationItemKey(fresh)), false);

    const worklist = [inFlightFr, fresh];
    const filtered = worklist.filter((item) => !pending.inFlightKeys.has(translationItemKey(item)));
    assert.deepEqual(filtered, [fresh]);
  });

  it("returns nothing once the job is ingested", () => {
    const { config } = makeFixture();
    const { jobRow } = persistJob(config);
    ingestBatchJob(config, jobRow, { state: "JOB_STATE_FAILED", error: { message: "x" } });

    const pending = readPendingBatchWork(config);
    assert.equal(pending.jobs.length, 0);
    assert.equal(pending.inFlightKeys.size, 0);
  });
});
