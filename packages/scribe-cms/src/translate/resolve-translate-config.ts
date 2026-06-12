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
      "Provide a URL slug in JSON field `slug` that is TRANSLATED into the target language.",
      "Base the slug on the meaning of the translated title — do NOT reuse the English slug words.",
      "Slug MUST be ASCII only: a-z, 0-9, hyphens. No uppercase, accents, underscores, or spaces.",
      "For non-Latin languages, write the words in the target language and transliterate them into Latin script (e.g. Russian -> romanized Russian, not English).",
      "Do NOT append locale codes to the slug (e.g. -fr, -he, -zh-cn). Locale routing is handled by the URL prefix, not the slug.",
      'In JSX attributes (e.g. FaqItem question="..."), use single quotes when the value contains double-quote characters (e.g. Hebrew דוא"ל), or escape them as \\".',
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
