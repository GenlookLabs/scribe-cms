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

const BUILTIN_TRANSLATE_RULES = [
  "Placeholders written as %%1%%, %%2%%, %%3%% (double percent signs around a number) are immutable. Reproduce each placeholder that appears in the source EXACTLY as-is, exactly once, and never translate, edit, renumber, or add spaces inside it. You may move a placeholder to a different position within its sentence when the target grammar requires it.",
  "Do not translate brand or product names unless the brand has a well-known localized name in the target market (rare). Keep the original spelling and capitalization.",
  "Return the MDX body with real line breaks; do not use JSON escape sequences like \\n or \\t in the body string.",
  'In JSX attributes (e.g. FaqItem question="..."), use single quotes when the value contains double-quote characters (e.g. Hebrew דוא"ל), or escape them as \\".',
  "Match the EN source format: when the EN body uses Markdown/MDX (headings, paragraphs, GFM tables, links), keep that structure in the translation. Do not convert markdown elements into raw HTML (<p>, <h2>, <table>, etc.).",
  "Otherwise match the format and components used in the EN source.",
];

function slugStrategyRules(slugStrategy: SlugStrategy): string[] {
  if (slugStrategy === "localized") {
    return [
      "Provide a URL slug in JSON field `slug` that is Localized into the target language.",
      "Base the slug on the meaning of the translated title — do NOT reuse the English slug words.",
      "Slug MUST be ASCII only: a-z, 0-9, hyphens. No uppercase, accents, underscores, or spaces.",
      "For non-Latin languages, write the words in the target language and transliterate them into Latin script (e.g. Russian -> romanized Russian, not English).",
      "Do NOT append locale codes to the slug (e.g. -fr, -he, -zh-cn). Locale routing is handled by the URL prefix, not the slug.",
      "Preserve 4-digit years and proper nouns in slugs.",
    ];
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
      ...BUILTIN_TRANSLATE_RULES,
      ...(project?.rules ?? []),
      ...(type?.rules ?? []),
      ...slugStrategyRules(slugStrategy),
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
