import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { estimateDryRunUsage, estimateTranslationCostUsd } from "./gemini-pricing.js";

describe("estimateDryRunUsage", () => {
  it("derives input tokens from the prompt and output tokens from the payload", () => {
    const prompt = "x".repeat(400);
    const translatableFrontmatter = { title: "Hello world" };
    const enBody = "y".repeat(200);

    const usage = estimateDryRunUsage({ prompt, translatableFrontmatter, enBody });

    const payloadChars = JSON.stringify(translatableFrontmatter).length + enBody.length;
    assert.equal(usage.inputTokens, Math.ceil(prompt.length / 4));
    assert.equal(usage.outputTokens, Math.ceil((payloadChars / 4) * 1.5));
    assert.ok(usage.inputTokens > 0);
    assert.ok(usage.outputTokens > 0);
  });
});

describe("estimateTranslationCostUsd (batch vs interactive)", () => {
  it("prices batch tokens at half the interactive rate", () => {
    const interactive = estimateTranslationCostUsd("gemini-3.1-pro", 2_700, 5_000, "interactive");
    const batch = estimateTranslationCostUsd("gemini-3.1-pro", 2_700, 5_000, "batch");
    assert.ok(interactive && interactive > 0);
    assert.ok(batch);
    assert.equal(batch, interactive * 0.5);
  });
});
