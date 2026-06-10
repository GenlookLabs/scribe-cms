import type {
  ContentTypeConfig,
  ScribeConfig,
  ScribeTranslateDefaults,
  SlugStrategy,
  TranslateConfig,
} from "../core/types.js";

export interface ResolvedTranslateConfig {
  promptOverride?: string;
  context?: string;
  rules: string[];
  model?: string;
}

function slugStrategyRules(
  slugStrategy: SlugStrategy,
  preserveTerms?: string[],
): string[] {
  if (slugStrategy === "localized") {
    const rules = [
      "Provide a localized URL slug in JSON field `slug`.",
      "Slug MUST be ASCII only: a-z, 0-9, hyphens. No uppercase, accents, underscores, or spaces.",
      "For non-Latin locales, transliterate into Latin script.",
    ];
    if (preserveTerms?.length) {
      rules.push(
        `Preserve these terms verbatim in slugs (lowercase): ${preserveTerms.join(", ")}.`,
      );
    } else {
      rules.push("Preserve 4-digit years and proper nouns in slugs.");
    }
    return rules;
  }
  return ["Do NOT output a slug — slugStrategy is fixed."];
}

function mergeContext(
  project: ScribeTranslateDefaults | undefined,
  type: TranslateConfig | undefined,
): string | undefined {
  const parts = [project?.context, type?.context].filter(Boolean);
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function mergeTranslateConfig(
  project: ScribeTranslateDefaults | undefined,
  type: TranslateConfig | undefined,
  slugStrategy: SlugStrategy,
): ResolvedTranslateConfig {
  return {
    promptOverride: type?.prompt ?? project?.prompt,
    context: mergeContext(project, type),
    rules: [
      ...(project?.rules ?? []),
      ...(type?.rules ?? []),
      ...slugStrategyRules(slugStrategy, project?.slugPreserveTerms),
    ],
    model: type?.model ?? project?.defaultModel,
  };
}

/** Merge project and content-type translation settings. */
export function resolveTranslateConfig(
  config: ScribeConfig,
  type: ContentTypeConfig,
): ResolvedTranslateConfig {
  return mergeTranslateConfig(config.translate, type.translate, type.slugStrategy);
}
