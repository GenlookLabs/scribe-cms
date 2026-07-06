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
 * Build a page translation prompt whose prefix (everything up to and including
 * the EN body) does not vary with locale, and whose suffix carries all
 * locale-specific instructions. This lets Gemini reuse the cached prefix when the
 * same page is translated into multiple locales.
 */
export function buildPageTranslationPrompt(input: {
  resolved: ResolvedTranslateConfig;
  targetLocale: string;
  contextLabel?: string;
  translatableFrontmatter: Record<string, unknown>;
  enBody: string;
  slugStrategy: SlugStrategy;
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
    input.slugStrategy === "localized"
      ? "`frontmatter` (object with translated frontmatter fields), `body` (string, full MDX body), `slug` (string)."
      : "`frontmatter` (object), `body` (string).",
  ];

  return [...prefix, ...suffix].join("\n");
}
