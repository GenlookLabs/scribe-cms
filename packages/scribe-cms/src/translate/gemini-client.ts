import { GoogleGenAI, type GenerateContentConfig, type GenerateContentResponse } from "@google/genai";
import {
  DEFAULT_GEMINI_MODEL,
  normalizeGeminiDisplayName,
  resolveGeminiModelId,
  resolveThinkingConfig,
} from "./gemini-models.js";
import { withRetry } from "./retry.js";

const DEFAULT_MODEL = DEFAULT_GEMINI_MODEL;

export interface GeminiTokenUsage {
  inputTokens: number;
  /** Billed output tokens; INCLUDES thoughts tokens. */
  outputTokens: number;
  /** Thoughts (reasoning) tokens, billed as output. */
  thoughtsTokens: number;
  totalTokens: number;
}

export interface GeminiTranslationResult {
  model: string;
  raw: string;
  parsed: {
    frontmatter: Record<string, unknown>;
    body: string;
    slug?: string;
  };
  usage: GeminiTokenUsage;
}

function extractJson(text: string): string {
  const trimmed = text.trim();
  // Only strip a fence that wraps the entire payload, so fences inside string
  // values (e.g. a translated MDX body with ```ts blocks) are left untouched.
  const fenced = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  if (fenced?.[1]) return fenced[1].trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

export function parseGeminiResponse(text: string): {
  frontmatter: Record<string, unknown>;
  body: string;
  slug?: string;
} {
  // With responseMimeType "application/json" the payload is already pure JSON.
  // Parse it directly first; only fall back to extraction when the model wraps
  // or pads the JSON (extraction is fragile when the body contains code fences).
  try {
    return JSON.parse(text.trim());
  } catch {
    return JSON.parse(extractJson(text));
  }
}

/**
 * Build the per-request generation config shared by the direct and batch paths.
 * The same shape is passed to `generateContent` and to each inlined batch request.
 */
export function buildGeminiRequestConfig(input: {
  apiModelId: string;
  responseSchema?: Record<string, unknown>;
}): GenerateContentConfig {
  const thinkingConfig = resolveThinkingConfig(input.apiModelId);
  return {
    responseMimeType: "application/json",
    ...(input.responseSchema ? { responseSchema: input.responseSchema } : {}),
    ...(thinkingConfig ? { thinkingConfig } : {}),
  };
}

interface WireUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
  prompt_token_count?: number;
  candidates_token_count?: number;
  thoughts_token_count?: number;
  total_token_count?: number;
}

/**
 * Extract token usage from a Gemini response; thoughts are folded into output.
 * Batch inlined responses arrive as raw JSON rather than SDK class instances,
 * so tolerate both camelCase and snake_case field names.
 */
export function usageFromResponse(response: GenerateContentResponse): GeminiTokenUsage {
  const meta = (response.usageMetadata ??
    (response as unknown as { usage_metadata?: WireUsageMetadata }).usage_metadata ??
    {}) as WireUsageMetadata;
  const thoughtsTokens = meta.thoughtsTokenCount ?? meta.thoughts_token_count ?? 0;
  return {
    inputTokens: meta.promptTokenCount ?? meta.prompt_token_count ?? 0,
    // candidatesTokenCount does not include thoughts, but thoughts are billed as
    // output tokens, so fold them in here for accurate cost accounting.
    outputTokens: (meta.candidatesTokenCount ?? meta.candidates_token_count ?? 0) + thoughtsTokens,
    thoughtsTokens,
    totalTokens: meta.totalTokenCount ?? meta.total_token_count ?? 0,
  };
}

export async function translatePageWithGemini(input: {
  prompt: string;
  model?: string;
  apiKey?: string;
  responseSchema?: Record<string, unknown>;
}): Promise<GeminiTranslationResult> {
  const apiKey = input.apiKey ?? process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is required for scribe translate");
  }

  const displayModel = normalizeGeminiDisplayName(
    input.model ?? process.env.PROSE_GEMINI_MODEL ?? DEFAULT_MODEL,
  );
  const apiModel = resolveGeminiModelId(displayModel);
  const ai = new GoogleGenAI({ apiKey });
  const response = await withRetry(() =>
    ai.models.generateContent({
      model: apiModel,
      contents: input.prompt,
      config: buildGeminiRequestConfig({
        apiModelId: apiModel,
        responseSchema: input.responseSchema,
      }),
    }),
  );

  const raw = response.text ?? "";
  const parsed = parseGeminiResponse(raw);

  if (!parsed.frontmatter || typeof parsed.body !== "string") {
    throw new Error("Gemini response missing frontmatter/body");
  }

  return { model: displayModel, raw, parsed, usage: usageFromResponse(response) };
}
