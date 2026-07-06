import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { field } from "../core/field.js";
import type { ContentTypeConfig, ScribeConfig } from "../core/types.js";
import { openStore } from "../storage/sqlite.js";
import { buildRetryWorklist, runRetryRound } from "./page-translator.js";
import { translationItemKey, type TranslatePageResult } from "./translate-core.js";
import type { TranslationWorkItem } from "./worklist.js";

const blogSchema = z.object({
  title: field.translatable(z.string().min(1)),
});

function makeConfig(): ScribeConfig {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-retry-test-"));
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
    localeFallbacks: {},
    types: [type],
  };
  openStore(config, "readwrite").close();
  return config;
}

function failedResult(
  enSlug: string,
  locale: string,
  error: string,
): TranslatePageResult {
  return {
    contentType: "blog",
    enSlug,
    locale,
    skipped: false,
    failed: true,
    error,
    durationMs: 1,
  };
}

describe("buildRetryWorklist", () => {
  it("carries the verbatim error and preserves the original EN hash", () => {
    const original: TranslationWorkItem = {
      contentType: "blog",
      enSlug: "hello-world",
      locale: "fr",
      reason: "stale",
      currentEnHash: "hash-1",
      storedEnHash: "hash-0",
    };
    const originalByKey = new Map([[translationItemKey(original), original]]);
    const error = "Translation validation failed: description: Too big";

    const retry = buildRetryWorklist(
      [failedResult("hello-world", "fr", error)],
      originalByKey,
    );

    assert.equal(retry.length, 1);
    assert.equal(retry[0]!.previousError, error);
    assert.equal(retry[0]!.currentEnHash, "hash-1");
    assert.equal(retry[0]!.reason, "stale");
    assert.equal(retry[0]!.storedEnHash, "hash-0");
  });

  it("rebuilds items with no matching original (resumed batch items)", () => {
    const retry = buildRetryWorklist(
      [failedResult("orphan", "ru", "Unexpected end of JSON input")],
      new Map(),
    );
    assert.equal(retry[0]!.previousError, "Unexpected end of JSON input");
    assert.equal(retry[0]!.reason, "missing");
    assert.equal(retry[0]!.currentEnHash, "");
  });
});

describe("runRetryRound (direct)", () => {
  it("retries each failed item exactly once with error context, merging outcomes", async () => {
    const config = makeConfig();
    const retryItems = buildRetryWorklist(
      [
        failedResult("page-a", "fr", "Translation validation failed: itemList: Too small"),
        failedResult("page-b", "fr", "Unexpected end of JSON input"),
      ],
      new Map(),
    );

    const seen: TranslationWorkItem[] = [];
    const results: TranslatePageResult[] = [];

    await runRetryRound(config, retryItems, {
      concurrency: 2,
      mode: "direct",
      onResult: (result) => results.push(result),
      translateOne: async (item) => {
        seen.push(item);
        // page-a is fixed on retry; page-b fails again with a new error.
        if (item.enSlug === "page-a") {
          return {
            contentType: "blog",
            enSlug: "page-a",
            locale: "fr",
            skipped: false,
            model: "gemini-3.1-pro",
            usage: { inputTokens: 10, outputTokens: 20, thoughtsTokens: 0, totalTokens: 30 },
            estimatedCostUsd: 0.01,
            durationMs: 5,
          };
        }
        return failedResult("page-b", "fr", "Translation validation failed: title: Required");
      },
    });

    // Exactly one retry per item, and each retry saw its verbatim prior error.
    assert.equal(seen.length, 2);
    const byKey = new Map(seen.map((item) => [item.enSlug, item]));
    assert.match(byKey.get("page-a")!.previousError!, /itemList: Too small/);
    assert.match(byKey.get("page-b")!.previousError!, /Unexpected end of JSON input/);

    // page-a now translated; page-b reported once with its NEW error.
    const resultByKey = new Map(results.map((r) => [r.enSlug, r]));
    assert.equal(resultByKey.get("page-a")!.failed, undefined);
    assert.equal(resultByKey.get("page-b")!.failed, true);
    assert.match(resultByKey.get("page-b")!.error!, /title: Required/);
    // Not retried a second time within the run.
    assert.equal(results.filter((r) => r.enSlug === "page-b").length, 1);
  });
});
