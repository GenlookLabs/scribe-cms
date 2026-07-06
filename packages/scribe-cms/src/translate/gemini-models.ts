import { ThinkingLevel, type ThinkingConfig } from "@google/genai";

/** Display name -> Gemini API model id. Pricing and logs use the display name. */
export const GEMINI_MODEL_IDS: Record<string, string> = {
  "gemini-2.5-pro": "gemini-2.5-pro",
  "gemini-3.1-pro": "gemini-3.1-pro-preview",
};

export const DEFAULT_GEMINI_MODEL = "gemini-3.1-pro";

function stripModelsPrefix(model: string): string {
  return model.replace(/^models\//, "");
}

/** Map a display name (or passthrough id) to the API model id. */
export function resolveGeminiModelId(model: string): string {
  const name = stripModelsPrefix(model);
  return GEMINI_MODEL_IDS[name] ?? name;
}

/** Normalize any model id/alias to the display name used for pricing. */
export function normalizeGeminiDisplayName(model: string): string {
  const name = stripModelsPrefix(model);
  if (name in GEMINI_MODEL_IDS) return name;

  const alias = Object.entries(GEMINI_MODEL_IDS).find(([, apiId]) => apiId === name);
  if (alias) return alias[0];

  return name;
}

/**
 * Resolve the thinking config to keep translation cheap and predictable.
 * - Gemini 3.x: `thinkingLevel: LOW` (the 2.5-style `thinkingBudget` is unsupported).
 * - Gemini 2.5-pro: cannot fully disable thinking; use the minimum budget of 128.
 * - Unknown/passthrough ids: LOW for "gemini-3*", budget 128 for ids containing "2.5",
 *   otherwise no thinking config (let the model default).
 */
export function resolveThinkingConfig(apiModelId: string): ThinkingConfig | undefined {
  const id = stripModelsPrefix(apiModelId).toLowerCase();
  if (id.startsWith("gemini-3")) return { thinkingLevel: ThinkingLevel.LOW };
  if (id.includes("2.5")) return { thinkingBudget: 128 };
  return undefined;
}
