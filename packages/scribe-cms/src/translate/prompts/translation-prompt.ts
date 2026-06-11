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
  ja: "Japanese",
  ru: "Russian",
  it: "Italian",
  ar: "Arabic",
};

export function defaultLocalizationPrompt(localeName: string, locale: string): string {
  return [
    `Localize the content below into natural ${localeName} (${locale}).`,
    "Do not translate word-for-word.",
    "Preserve the source tone and brand voice.",
    "Write as if a native speaker authored it for the target market.",
  ].join(" ");
}

export function buildPageTranslationPrompt(input: {
  resolved: ResolvedTranslateConfig;
  targetLocale: string;
  contextLabel?: string;
  translatableFrontmatter: Record<string, unknown>;
  enBody: string;
  slugStrategy: SlugStrategy;
}): string {
  const localeName = LOCALE_NAMES[input.targetLocale] ?? input.targetLocale;
  const prompt =
    input.resolved.promptOverride ??
    defaultLocalizationPrompt(localeName, input.targetLocale);

  const lines = [
    prompt,
    "",
    ...(input.resolved.context ? ["## Context", input.resolved.context, ""] : []),
    ...(input.contextLabel ? [`Document: ${input.contextLabel}`, ""] : []),
    "## Rules",
    ...input.resolved.rules.map((rule) => `- ${rule}`),
    "",
    "## Output format",
    "Return ONLY valid JSON with keys:",
    input.slugStrategy === "localized"
      ? '`frontmatter` (object with translated frontmatter fields), `body` (string, full MDX body), `slug` (string).'
      : "`frontmatter` (object), `body` (string).",
    "",
    "## EN translatable frontmatter (JSON)",
    JSON.stringify(input.translatableFrontmatter, null, 2),
    "",
    "## EN body (MDX)",
    input.enBody,
  ];

  return lines.join("\n");
}
