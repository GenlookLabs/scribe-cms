import { GoogleGenAI } from "@google/genai";

const DEFAULT_MODEL = "gemini-2.5-pro";

export interface GeminiTranslationResult {
  model: string;
  raw: string;
  parsed: {
    frontmatter: Record<string, unknown>;
    body: string;
    slug?: string;
  };
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
}): Promise<GeminiTranslationResult> {
  const apiKey = input.apiKey ?? process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is required for scribe translate");
  }

  const model = input.model ?? process.env.PROSE_GEMINI_MODEL ?? DEFAULT_MODEL;
  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model,
    contents: input.prompt,
    config: {
      responseMimeType: "application/json",
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

  return { model, raw, parsed };
}
