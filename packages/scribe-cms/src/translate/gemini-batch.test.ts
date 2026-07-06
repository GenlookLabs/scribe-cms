import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GenerateContentResponse } from "@google/genai";
import {
  isSuccessfulBatchState,
  isTerminalBatchState,
  normalizeBatchState,
  textFromBatchResponse,
} from "./gemini-batch.js";

describe("normalizeBatchState", () => {
  it("strips the live BATCH_STATE_ family prefix", () => {
    // The live REST API reports BATCH_STATE_*; the SDK documents JOB_STATE_*.
    assert.equal(normalizeBatchState("BATCH_STATE_SUCCEEDED"), "SUCCEEDED");
    assert.equal(normalizeBatchState("BATCH_STATE_RUNNING"), "RUNNING");
    assert.equal(normalizeBatchState("BATCH_STATE_PENDING"), "PENDING");
  });

  it("strips the documented JOB_STATE_ family prefix", () => {
    assert.equal(normalizeBatchState("JOB_STATE_SUCCEEDED"), "SUCCEEDED");
    assert.equal(normalizeBatchState("JOB_STATE_FAILED"), "FAILED");
  });

  it("passes bare and unknown states through", () => {
    assert.equal(normalizeBatchState("RUNNING"), "RUNNING");
    assert.equal(normalizeBatchState(undefined), "UNKNOWN");
  });
});

describe("isTerminalBatchState / isSuccessfulBatchState", () => {
  it("treats both state families as terminal", () => {
    for (const state of [
      "BATCH_STATE_SUCCEEDED",
      "JOB_STATE_SUCCEEDED",
      "BATCH_STATE_FAILED",
      "BATCH_STATE_CANCELLED",
      "BATCH_STATE_EXPIRED",
      "BATCH_STATE_PARTIALLY_SUCCEEDED",
    ]) {
      assert.equal(isTerminalBatchState(state), true, state);
    }
  });

  it("does not treat in-progress states as terminal", () => {
    for (const state of ["BATCH_STATE_RUNNING", "JOB_STATE_PENDING", "BATCH_STATE_PENDING"]) {
      assert.equal(isTerminalBatchState(state), false, state);
    }
  });

  it("counts SUCCEEDED and PARTIALLY_SUCCEEDED as successful, in either family", () => {
    assert.equal(isSuccessfulBatchState("BATCH_STATE_SUCCEEDED"), true);
    assert.equal(isSuccessfulBatchState("JOB_STATE_SUCCEEDED"), true);
    assert.equal(isSuccessfulBatchState("BATCH_STATE_PARTIALLY_SUCCEEDED"), true);
    assert.equal(isSuccessfulBatchState("BATCH_STATE_FAILED"), false);
    assert.equal(isSuccessfulBatchState("BATCH_STATE_RUNNING"), false);
  });
});

describe("textFromBatchResponse", () => {
  it("skips thought parts and joins the remaining text (batch responses lack a .text getter)", () => {
    // Batch inlined responses arrive as plain JSON objects, so response.text is
    // undefined and candidates/parts must be read directly.
    const response = {
      candidates: [
        {
          content: {
            parts: [
              { thought: true, text: "internal reasoning" },
              { text: '{"frontmatter":' },
              { text: '{"title":"Bonjour"},"body":"Corps."}' },
            ],
          },
        },
      ],
    } as unknown as GenerateContentResponse;

    assert.equal(
      textFromBatchResponse(response),
      '{"frontmatter":{"title":"Bonjour"},"body":"Corps."}',
    );
  });

  it("prefers the .text getter when present (direct responses)", () => {
    const response = { text: "already-text" } as unknown as GenerateContentResponse;
    assert.equal(textFromBatchResponse(response), "already-text");
  });
});
