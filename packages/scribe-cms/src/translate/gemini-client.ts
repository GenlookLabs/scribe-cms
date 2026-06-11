import { GoogleGenAI } from "@google/genai";
import {
  DEFAULT_GEMINI_MODEL,
  normalizeGeminiDisplayName,
  resolveGeminiModelId,
} from "./gemini-models.js";

const DEFAULT_MODEL = DEFAULT_GEMINI_MODEL;

export interface GeminiTokenUsage {
  inputTokens: number;
  outputTokens: number;
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
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) return fenced[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return text.trim();
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
  const response = await ai.models.generateContent({
    model: apiModel,
    contents: input.prompt,
    config: {
      responseMimeType: "application/json",
      ...(input.responseSchema ? { responseSchema: input.responseSchema } : {}),
    },
  });

  const raw = response.text ?? "";
  const parsed = JSON.parse(extractJson(raw)) as {
    frontmatter: Record<string, unknown>;
    body: string;
    slug?: string;
  };

  if (!parsed.frontmatter || typeof parsed.body !== "string") {
    throw new Error("Gemini response missing frontmatter/body");
  }

  const usageMetadata = response.usageMetadata;
  const usage: GeminiTokenUsage = {
    inputTokens: usageMetadata?.promptTokenCount ?? 0,
    outputTokens: usageMetadata?.candidatesTokenCount ?? 0,
    totalTokens: usageMetadata?.totalTokenCount ?? 0,
  };

  return { model: displayModel, raw, parsed, usage };
}
