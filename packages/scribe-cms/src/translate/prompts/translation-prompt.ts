import type { ResolvedTranslateConfig } from "../resolve-translate-config.js";
import type { SlugStrategy } from "../../core/types.js";

export const LOCALE_NAMES: Record<string, string> = {
  fr: "French",
  es: "Spanish",
  de: "German",
  nl: "Dutch",
  uk: "Ukrainian",
  tr: "Turkish",
  da: "Danish",
  he: "Hebrew",
  "zh-CN": "Simplified Chinese",
  "zh-TW": "Traditional Chinese",
  pt: "Portuguese",
  "pt-BR": "Brazilian Portuguese",
  ja: "Japanese",
  ru: "Russian",
  it: "Italian",
  ar: "Arabic",
};

export function defaultLocalizationPrompt(localeName: string, locale: string): string {
  return [
    `Localize the content above into natural ${localeName} (${locale}).`,
    "Do not translate word-for-word.",
    "Preserve the source tone and brand voice.",
    "Write as if a native speaker authored it for the target market.",
  ].join(" ");
}

/**
 * Static, locale-independent framing. Kept first so the whole prompt PREFIX
 * (framing + context + rules + EN payload) is byte-identical across every locale
 * of a given page, enabling Gemini implicit prefix caching. The locale-specific
 * localization directive lives in the SUFFIX, after the EN body.
 */
const TASK_FRAMING =
  "You are localizing the content below into a target language specified at the end of this prompt.";

/**
 * Describe the expected JSON keys. Mirrors buildGeminiResponseSchema: types
 * without translatable frontmatter get a body-only response (their structural
 * frontmatter is carried over from EN, not translated).
 */
function buildOutputFormatLine(hasFrontmatter: boolean, slugStrategy: SlugStrategy): string {
  if (!hasFrontmatter) {
    return slugStrategy === "localized"
      ? "`body` (string, full MDX body), `slug` (string)."
      : "`body` (string, full MDX body).";
  }
  return slugStrategy === "localized"
    ? "`frontmatter` (object with translated frontmatter fields), `body` (string, full MDX body), `slug` (string)."
    : "`frontmatter` (object), `body` (string).";
}

/**
 * Build a page translation prompt whose prefix (everything up to and including
 * the EN body) does not vary with locale, and whose suffix carries all
 * locale-specific instructions. This lets Gemini reuse the cached prefix when the
 * same page is translated into multiple locales.
 */
/**
 * Compose the retry-context section appended (locale-specific suffix only, never
 * the cached prefix) when a previous attempt was rejected by validation. The
 * validation errors are included verbatim so the model can fix the exact issues.
 */
function buildRetryContextSection(previousError: string): string[] {
  return [
    "",
    "## Previous attempt",
    `A previous attempt at this translation was rejected with the following validation errors: ${previousError}. Produce a corrected translation that fixes these issues while re-checking every schema constraint (required fields, array minimums, maximum lengths).`,
  ];
}

export function buildPageTranslationPrompt(input: {
  resolved: ResolvedTranslateConfig;
  targetLocale: string;
  contextLabel?: string;
  translatableFrontmatter: Record<string, unknown>;
  enBody: string;
  slugStrategy: SlugStrategy;
  /** Verbatim validation errors from a prior rejected attempt (retry round). */
  previousError?: string;
}): string {
  const localeName = LOCALE_NAMES[input.targetLocale] ?? input.targetLocale;
  const localizationPrompt =
    input.resolved.promptOverride ??
    defaultLocalizationPrompt(localeName, input.targetLocale);

  // PREFIX — locale-independent. Identical for every locale of a given page.
  const prefix = [
    TASK_FRAMING,
    "",
    ...(input.resolved.context ? ["## Context", input.resolved.context, ""] : []),
    ...(input.contextLabel ? [`Document: ${input.contextLabel}`, ""] : []),
    "## Rules",
    ...input.resolved.rules.map((rule) => `- ${rule}`),
    "",
    "## EN translatable frontmatter (JSON)",
    JSON.stringify(input.translatableFrontmatter, null, 2),
    "",
    "## EN body (MDX)",
    input.enBody,
  ];

  // SUFFIX — locale-specific. Everything that depends on the target locale must
  // come after the EN body so it never changes the cacheable prefix.
  const suffix = [
    "",
    "## Target language",
    localizationPrompt,
    ...(input.slugStrategy === "localized"
      ? [
          `The slug MUST be written in ${localeName}, derived from the ${localeName} title and its meaning — never the English slug.`,
        ]
      : []),
    "",
    "## Output format",
    "Return ONLY valid JSON with keys:",
    buildOutputFormatLine(
      Object.keys(input.translatableFrontmatter).length > 0,
      input.slugStrategy,
    ),
    // Retry context is locale-specific suffix material: it MUST stay after the
    // EN body so the cacheable prefix is byte-identical with and without it.
    ...(input.previousError ? buildRetryContextSection(input.previousError) : []),
  ];

  return [...prefix, ...suffix].join("\n");
}
