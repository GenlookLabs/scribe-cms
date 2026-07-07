const CONTEXT_TIER_TOKENS = 200_000;

export interface TieredModelPricing {
  input: readonly [le200kUsdPerMillion: number, gt200kUsdPerMillion: number];
  output: readonly [le200kUsdPerMillion: number, gt200kUsdPerMillion: number];
}

/** display_name -> { input: (le_200k, gt_200k), output: (le_200k, gt_200k) } in USD per 1M tokens */
export const GEMINI_PRICING_USD: Record<string, TieredModelPricing> = {
  "gemini-3.1-pro": { input: [2.0, 4.0], output: [12.0, 18.0] },
};

function normalizeModelId(model: string): string {
  return model.replace(/^models\//, "").toLowerCase();
}

function tierRate(tokens: number, tiers: readonly [number, number]): number {
  return tokens <= CONTEXT_TIER_TOKENS ? tiers[0] : tiers[1];
}

export function resolveModelPricing(model: string): TieredModelPricing | undefined {
  const id = normalizeModelId(model);
  if (GEMINI_PRICING_USD[id]) return GEMINI_PRICING_USD[id];

  const match = Object.entries(GEMINI_PRICING_USD).find(([key]) => id.includes(key));
  return match?.[1];
}

export type TranslationCostMode = "interactive" | "batch";

/** Batch API tokens are billed at 50% of interactive rates. */
const BATCH_DISCOUNT = 0.5;

export function estimateTranslationCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  mode: TranslationCostMode = "interactive",
): number | undefined {
  const pricing = resolveModelPricing(model);
  if (!pricing) return undefined;

  const inputRate = tierRate(inputTokens, pricing.input);
  const outputRate = tierRate(outputTokens, pricing.output);
  const multiplier = mode === "batch" ? BATCH_DISCOUNT : 1;

  return (
    ((inputTokens / 1_000_000) * inputRate +
      (outputTokens / 1_000_000) * outputRate) *
    multiplier
  );
}

/**
 * Rough token estimate for a dry run, where no model call is made. Both figures
 * are heuristics, not measurements:
 *   - inputTokens ≈ prompt characters / 4 (the usual ~4 chars/token ratio).
 *   - outputTokens ≈ (translatable payload characters / 4) × 1.5: the translated
 *     output is roughly the source length; the 1.5 factor covers thinking tokens
 *     at thinkingLevel LOW plus JSON wrapping.
 * Observed range: 2.7k-token-input pages produced 2.3k–7.9k output tokens.
 */
export function estimateDryRunUsage(input: {
  prompt: string;
  translatableFrontmatter: unknown;
  enBody: string;
}): { inputTokens: number; outputTokens: number } {
  const payloadChars = JSON.stringify(input.translatableFrontmatter).length + input.enBody.length;
  return {
    inputTokens: Math.ceil(input.prompt.length / 4),
    outputTokens: Math.ceil((payloadChars / 4) * 1.5),
  };
}

export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

export function formatUsd(amount: number | undefined): string {
  if (amount === undefined) return "n/a";
  if (amount >= 1) return `$${amount.toFixed(2)}`;
  if (amount >= 0.01) return `$${amount.toFixed(3)}`;
  return `$${amount.toFixed(4)}`;
}
