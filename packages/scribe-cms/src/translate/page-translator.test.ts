import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { GenerateContentResponse } from "@google/genai";
import { field } from "../core/field.js";
import type { ContentTypeConfig, ScribeConfig, ScribeDocument } from "../core/types.js";
import { openStore } from "../storage/sqlite.js";
import { getTranslation } from "../storage/translations.js";
import { usageFromResponse } from "./gemini-client.js";
import { textFromBatchResponse } from "./gemini-batch.js";
import { estimateTranslationCostUsd } from "./gemini-pricing.js";
import {
  finalizeTranslation,
  translatePage,
  translateWorklist,
  type PreparedTranslation,
  type TranslateProgressEvent,
} from "./page-translator.js";
import type { TranslationWorkItem } from "./worklist.js";

const blogSchema = z.object({
  title: field.translatable(z.string().min(1)),
});

function makeFixture(slugStrategy: "fixed" | "localized" = "localized") {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-batch-test-"));
  const type: ContentTypeConfig = {
    id: "blog",
    schema: blogSchema,
    contentDir: "blog",
    label: "Blog",
    slugStrategy,
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
  // Create the store up front, as in a real project where it is committed.
  openStore(config, "readwrite").close();
  const item: TranslationWorkItem = {
    contentType: "blog",
    enSlug: "hello-world",
    locale: "fr",
    reason: "missing",
    currentEnHash: "hash-1",
  };
  const enDoc: ScribeDocument = {
    slug: "hello-world",
    enSlug: "hello-world",
    locale: "en",
    noindex: false,
    frontmatter: { title: "Hello world" },
    content: "Hello, this is the body.",
  };
  const prepared: PreparedTranslation = {
    item,
    type,
    enDoc,
    payload: { frontmatter: { title: "Hello world" }, body: enDoc.content },
    currentEnHash: "hash-1",
    model: "gemini-3.1-pro",
    prompt: "(prompt)",
    responseSchema: undefined,
  };
  return { config, prepared };
}

describe("finalizeTranslation (shared direct/batch post-processing)", () => {
  it("validates, strips locale suffixes, upserts and prices at the batch rate", () => {
    const { config, prepared } = makeFixture();
    const usage = { inputTokens: 1_000, outputTokens: 2_000, thoughtsTokens: 100, totalTokens: 3_100 };

    const result = finalizeTranslation(
      config,
      prepared,
      {
        model: "gemini-3.1-pro",
        parsed: {
          frontmatter: { title: "Bonjour le monde" },
          body: "Bonjour, voici le corps.",
          slug: "bonjour-le-monde-fr",
        },
        usage,
      },
      { costMode: "batch", startedAt: Date.now() },
    );

    assert.equal(result.failed, undefined);
    assert.equal(result.skipped, false);
    assert.deepEqual(result.slugAdjusted, {
      from: "bonjour-le-monde-fr",
      to: "bonjour-le-monde",
      matchedCode: "fr",
    });
    assert.deepEqual(result.usage, usage);
    // Batch pricing is 50% of the interactive estimate.
    const interactive = estimateTranslationCostUsd("gemini-3.1-pro", 1_000, 2_000);
    assert.ok(interactive);
    assert.equal(result.estimatedCostUsd, interactive * 0.5);

    const db = openStore(config, "readonly");
    const row = getTranslation(db, "blog", "hello-world", "fr");
    db.close();
    assert.ok(row);
    assert.equal(row.slug, "bonjour-le-monde");
    assert.equal(row.body, "Bonjour, voici le corps.");
    assert.equal(row.en_hash, "hash-1");
    assert.equal(row.model, "gemini-3.1-pro");
  });

  it("returns a failed result when frontmatter validation fails", () => {
    const { config, prepared } = makeFixture();

    const result = finalizeTranslation(
      config,
      prepared,
      {
        model: "gemini-3.1-pro",
        parsed: { frontmatter: {}, body: "Corps." },
        usage: { inputTokens: 10, outputTokens: 10, thoughtsTokens: 0, totalTokens: 20 },
      },
      { costMode: "batch", startedAt: Date.now() },
    );

    assert.equal(result.failed, true);
    assert.match(result.error ?? "", /Translation validation failed/);

    const db = openStore(config, "readonly");
    assert.equal(getTranslation(db, "blog", "hello-world", "fr"), undefined);
    db.close();
  });

  it("returns a failed result when the MDX body is invalid", () => {
    const { config, prepared } = makeFixture();

    const result = finalizeTranslation(
      config,
      prepared,
      {
        model: "gemini-3.1-pro",
        parsed: { frontmatter: { title: "Bonjour" }, body: "Texte avec <Unclosed" },
        usage: { inputTokens: 10, outputTokens: 10, thoughtsTokens: 0, totalTokens: 20 },
      },
      { costMode: "batch", startedAt: Date.now() },
    );

    assert.equal(result.failed, true);
    assert.ok(result.error);
  });
});

/**
 * A fixture backed by a real EN doc on disk so the dry-run path runs through
 * prepareTranslation (prompt + payload) end to end.
 */
function makeDryRunFixture() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-dryrun-test-"));
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
  const contentDir = path.join(tmpDir, "blog");
  fs.mkdirSync(contentDir, { recursive: true });
  fs.writeFileSync(
    path.join(contentDir, "hello-world.mdx"),
    `---\ntitle: Hello world\n---\n\nHello, this is the body.`,
    "utf8",
  );
  openStore(config, "readwrite").close();
  const item: TranslationWorkItem = {
    contentType: "blog",
    enSlug: "hello-world",
    locale: "fr",
    reason: "missing",
    currentEnHash: "hash-1",
  };
  return { config, item };
}

describe("dry-run usage estimate", () => {
  it("carries a non-zero token + cost estimate on a single-page dry run", async () => {
    const { config, item } = makeDryRunFixture();

    const result = await translatePage(config, item, { dryRun: true });

    assert.equal(result.skipped, false);
    assert.equal(result.failed, undefined);
    assert.ok(result.usage);
    assert.ok(result.usage.inputTokens > 0);
    assert.ok(result.usage.outputTokens > 0);
    assert.ok(result.estimatedCostUsd !== undefined && result.estimatedCostUsd > 0);
  });

  it("prices a batch dry run at half the interactive rate and aggregates totals", async () => {
    const { config, item } = makeDryRunFixture();

    const capture = () => {
      let totals: TranslateProgressEvent | undefined;
      const onProgress = (event: TranslateProgressEvent) => {
        if (event.type === "done") totals = event;
      };
      return { onProgress, get: () => totals };
    };

    const batchCap = capture();
    const [batch] = await translateWorklist(config, [item], {
      dryRun: true,
      mode: "batch",
      onProgress: batchCap.onProgress,
    });
    const [direct] = await translateWorklist(config, [item], {
      dryRun: true,
      mode: "direct",
    });

    assert.ok(batch?.usage && direct?.usage);
    // Same tokens either way — only the price differs by mode.
    assert.equal(batch.usage.inputTokens, direct.usage.inputTokens);
    assert.equal(batch.usage.outputTokens, direct.usage.outputTokens);
    assert.ok(batch.estimatedCostUsd && direct.estimatedCostUsd);
    assert.equal(batch.estimatedCostUsd, direct.estimatedCostUsd * 0.5);

    // Totals in the done event aggregate the per-item estimate.
    const done = batchCap.get();
    assert.ok(done && done.type === "done");
    assert.equal(done.totals.inputTokens, batch.usage.inputTokens);
    assert.equal(done.totals.outputTokens, batch.usage.outputTokens);
    assert.equal(done.totals.estimatedCostUsd, batch.estimatedCostUsd);
  });
});

describe("batch response helpers", () => {
  it("extracts text from plain-object batch responses, skipping thought parts", () => {
    const response = {
      candidates: [
        {
          content: {
            parts: [
              { thought: true, text: "internal reasoning" },
              { text: '{"frontmatter":{},' },
              { text: '"body":"x"}' },
            ],
          },
        },
      ],
    } as unknown as GenerateContentResponse;
    assert.equal(textFromBatchResponse(response), '{"frontmatter":{},"body":"x"}');
  });

  it("folds thought tokens into billed output tokens", () => {
    const response = {
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 200,
        thoughtsTokenCount: 50,
        totalTokenCount: 350,
      },
    } as unknown as GenerateContentResponse;
    assert.deepEqual(usageFromResponse(response), {
      inputTokens: 100,
      outputTokens: 250,
      thoughtsTokens: 50,
      totalTokens: 350,
    });
  });
});
