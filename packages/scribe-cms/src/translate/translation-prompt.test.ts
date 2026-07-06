import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPageTranslationPrompt } from "./prompts/translation-prompt.js";
import type { ResolvedTranslateConfig } from "./resolve-translate-config.js";

const resolved: ResolvedTranslateConfig = {
  model: "gemini-3.1-pro",
  promptOverride: undefined,
  context: "Genlook is a virtual try-on Shopify app.",
  rules: ["Do not translate brand names.", "Keep MDX components intact."],
};

const enBody = "# Hello\n\nThis is the body with a ```ts\ncode fence\n``` inside.";

function promptFor(targetLocale: string): string {
  return buildPageTranslationPrompt({
    resolved,
    targetLocale,
    contextLabel: "Hello page",
    translatableFrontmatter: { title: "Hello", description: "A greeting" },
    enBody,
    slugStrategy: "localized",
  });
}

describe("buildPageTranslationPrompt prefix caching invariant", () => {
  it("shares an identical prefix up to and including the EN body across locales", () => {
    const fr = promptFor("fr");
    const ru = promptFor("ru");

    const bodyMarker = `## EN body (MDX)\n${enBody}`;
    const frEnd = fr.indexOf(bodyMarker);
    const ruEnd = ru.indexOf(bodyMarker);
    assert.ok(frEnd > 0, "fr prompt contains the EN body section");
    assert.ok(ruEnd > 0, "ru prompt contains the EN body section");

    const frPrefix = fr.slice(0, frEnd + bodyMarker.length);
    const ruPrefix = ru.slice(0, ruEnd + bodyMarker.length);
    assert.equal(frPrefix, ruPrefix, "prompt prefix must be byte-identical across locales");
  });

  it("keeps locale-specific text strictly after the EN body", () => {
    const fr = promptFor("fr");
    const bodyMarker = `## EN body (MDX)\n${enBody}`;
    const splitAt = fr.indexOf(bodyMarker) + bodyMarker.length;
    const prefix = fr.slice(0, splitAt);
    const suffix = fr.slice(splitAt);

    assert.doesNotMatch(prefix, /French/, "prefix must not mention the target language");
    assert.doesNotMatch(prefix, /\(fr\)/, "prefix must not mention the locale code");
    assert.match(suffix, /French \(fr\)/, "suffix carries the localization directive");
    assert.match(suffix, /slug MUST be written in French/, "suffix carries the localized slug line");
    assert.match(suffix, /## Output format/, "suffix carries the output format block");
  });

  it("keeps context, rules and frontmatter in the shared prefix", () => {
    const fr = promptFor("fr");
    const bodyMarker = `## EN body (MDX)\n${enBody}`;
    const prefix = fr.slice(0, fr.indexOf(bodyMarker) + bodyMarker.length);

    assert.match(prefix, /## Context/);
    assert.match(prefix, /virtual try-on Shopify app/);
    assert.match(prefix, /Document: Hello page/);
    assert.match(prefix, /## Rules/);
    assert.match(prefix, /Do not translate brand names\./);
    assert.match(prefix, /## EN translatable frontmatter \(JSON\)/);
    assert.match(prefix, /"title": "Hello"/);
  });

  it("asks for body-only JSON when there is no translatable frontmatter", () => {
    // Mirrors buildGeminiResponseSchema: changelog-like types get a body-only
    // response schema, so the prompt must not ask for a frontmatter key.
    const prompt = buildPageTranslationPrompt({
      resolved,
      targetLocale: "fr",
      contextLabel: "0.0.7",
      translatableFrontmatter: {},
      enBody,
      slugStrategy: "fixed",
    });
    const outputFormat = prompt.slice(prompt.indexOf("## Output format"));
    assert.match(outputFormat, /`body` \(string, full MDX body\)\./);
    assert.doesNotMatch(outputFormat, /`frontmatter`/);
  });
});
