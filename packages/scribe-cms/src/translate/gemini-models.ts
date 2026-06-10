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
