import {
  type BatchJob,
  GoogleGenAI,
  type JobState,
  type GenerateContentResponse,
  type InlinedRequest,
} from "@google/genai";
import { withRetry } from "./retry.js";

// The SDK documents JOB_STATE_* names but the live API reports BATCH_STATE_*;
// the SDK maps only the states it knows to JOB_STATE_* and passes the rest
// through, so both families (and states persisted in either form) must be
// tolerated. Compare on the bare state name.
const STATE_FAMILY_PREFIX = /^(JOB_STATE_|BATCH_STATE_)/;

const TERMINAL_STATES = new Set([
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "EXPIRED",
  "PARTIALLY_SUCCEEDED",
]);

const SUCCESSFUL_STATES = new Set(["SUCCEEDED", "PARTIALLY_SUCCEEDED"]);

/** Strip the JOB_STATE_/BATCH_STATE_ family prefix: "BATCH_STATE_RUNNING" -> "RUNNING". */
export function normalizeBatchState(state: JobState | string | undefined): string {
  return String(state ?? "UNKNOWN").replace(STATE_FAMILY_PREFIX, "");
}

export function isTerminalBatchState(state: JobState | string | undefined): boolean {
  return TERMINAL_STATES.has(normalizeBatchState(state));
}

export function isSuccessfulBatchState(state: JobState | string | undefined): boolean {
  return SUCCESSFUL_STATES.has(normalizeBatchState(state));
}

function makeClient(apiKey?: string): GoogleGenAI {
  const key = apiKey ?? process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error("GEMINI_API_KEY is required for scribe translate");
  }
  return new GoogleGenAI({ apiKey: key });
}

/**
 * Extract the text payload from a batch GenerateContentResponse. Batch inlined
 * responses are plain JSON objects (the SDK does not rebuild the class), so the
 * `.text` getter is unavailable — read candidates/parts directly and skip
 * thought parts.
 */
export function textFromBatchResponse(response: GenerateContentResponse): string {
  if (typeof response.text === "string") return response.text;
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  return parts
    .filter((part) => !part.thought && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

/** Submit one Gemini Batch API job with inlined requests. */
export async function createGeminiBatchJob(input: {
  /** API model id (already resolved from the display name). */
  model: string;
  requests: InlinedRequest[];
  apiKey?: string;
  displayName?: string;
}): Promise<BatchJob> {
  const ai = makeClient(input.apiKey);
  const job = await withRetry(() =>
    ai.batches.create({
      model: input.model,
      src: input.requests,
      config: { displayName: input.displayName ?? `scribe-translate-${Date.now()}` },
    }),
  );
  if (!job.name) throw new Error("Gemini batch job was created without a name");
  return job;
}

/** Fetch the current state (and, when terminal, results) of a batch job. */
export async function getGeminiBatchJob(input: {
  name: string;
  apiKey?: string;
}): Promise<BatchJob> {
  const ai = makeClient(input.apiKey);
  return withRetry(() => ai.batches.get({ name: input.name }));
}
