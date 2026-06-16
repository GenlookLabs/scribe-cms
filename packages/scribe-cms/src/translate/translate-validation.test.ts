import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import { field } from "../core/field.js";
import { buildGeminiResponseSchema, buildTranslatableSubschema } from "./response-schema.js";
import {
  sanitizeTranslatedFrontmatter,
  validateTranslatedFrontmatter,
} from "./validate-translation.js";
import { buildPageTranslationPrompt } from "./prompts/translation-prompt.js";
import type { ScribeDocument } from "../core/types.js";

const pricingSchema = z.object({
  priceMonthlyUsd: field.structural(z.number().min(0)),
  name: field.structural(z.string().min(1)),
  features: field.translatable(z.array(z.string().min(1)).min(1)),
  schemaDescription: field.translatable(z.string().min(1)),
});

const blogSchema = z.object({
  title: field.translatable(z.string().min(1)),
  description: field.translatable(z.string().min(1)),
  author: field.relation("author"),
  itemList: field.structural(
    z.array(
      z.object({
        name: field.translatable(z.string().min(1)),
        position: field.structural(z.number().int()),
      }),
    ),
  ),
});

describe("buildTranslatableSubschema", () => {
  it("includes only translatable top-level fields for pricing", () => {
    const sub = buildTranslatableSubschema(pricingSchema);
    assert.ok(sub);
    const shape = sub.shape;
    assert.ok("features" in shape);
    assert.ok("schemaDescription" in shape);
    assert.equal("name" in shape, false);
    assert.equal("priceMonthlyUsd" in shape, false);
  });

  it("includes nested translatable fields inside structural arrays", () => {
    const sub = buildTranslatableSubschema(blogSchema);
    assert.ok(sub);
    const shape = sub.shape;
    assert.ok("title" in shape);
    assert.ok("description" in shape);
    assert.ok("itemList" in shape);
    assert.equal(shape.itemList?._def.type, "array");
    assert.equal("author" in shape, false);
  });
});

describe("buildGeminiResponseSchema", () => {
  it("returns frontmatter + body schema with additionalProperties false on frontmatter", () => {
    const schema = buildGeminiResponseSchema(pricingSchema, "fixed");
    assert.ok(schema);
    assert.equal(schema.type, "object");
    const props = schema.properties as Record<string, Record<string, unknown>>;
    assert.ok(props.frontmatter);
    assert.equal(props.frontmatter.additionalProperties, false);
    const fmProps = props.frontmatter.properties as Record<string, Record<string, unknown>>;
    assert.equal(fmProps.features.type, "array");
    assert.equal(fmProps.features.minItems, 1);
    assert.deepEqual(Object.keys(fmProps).sort(), ["features", "schemaDescription"]);
    assert.equal(props.body.type, "string");
    assert.equal("$schema" in schema, false);
  });

  it("adds slug for localized strategy", () => {
    const schema = buildGeminiResponseSchema(blogSchema, "localized");
    assert.ok(schema);
    const props = schema.properties as Record<string, Record<string, unknown>>;
    assert.ok(props.slug);
  });
});

describe("sanitizeTranslatedFrontmatter", () => {
  it("strips phantom title/description/name from pricing-like Gemini output", () => {
    const raw = {
      title: "Gratuit",
      description: "",
      name: "Gratis",
      features: ["10 essayages par mois inclus"],
      schemaDescription: "10 essayages par mois inclus.",
    };
    const sanitized = sanitizeTranslatedFrontmatter(raw, pricingSchema);
    assert.deepEqual(Object.keys(sanitized).sort(), ["features", "schemaDescription"]);
    assert.equal("title" in sanitized, false);
    assert.equal("description" in sanitized, false);
    assert.equal("name" in sanitized, false);
  });
});

describe("validateTranslatedFrontmatter", () => {
  const enDoc: ScribeDocument = {
    slug: "free",
    enSlug: "free",
    locale: "en",
    noindex: false,
    frontmatter: {
      priceMonthlyUsd: 0,
      name: "Free",
      features: ["10 monthly try-on included", "Customizable try-on widget"],
      schemaDescription: "10 monthly try-ons included. Customizable try-on widget.",
    },
    content: "",
  };

  it("accepts valid translatable output merged with EN structural fields", () => {
    const result = validateTranslatedFrontmatter(
      enDoc,
      {
        title: "Gratuit",
        features: ["10 essayages par mois inclus", "Widget try-on personnalisable"],
        schemaDescription: "10 essayages par mois inclus. Widget try-on personnalisable.",
      },
      pricingSchema,
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(Object.keys(result.frontmatter).sort(), ["features", "schemaDescription"]);
    }
  });

  it("rejects missing required translatable fields", () => {
    const result = validateTranslatedFrontmatter(
      enDoc,
      { features: ["only features, no schemaDescription"] },
      pricingSchema,
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /schemaDescription/i);
    }
  });
});

describe("buildPageTranslationPrompt", () => {
  it("does not include blog-style title/description metadata block", () => {
    const prompt = buildPageTranslationPrompt({
      resolved: { model: "gemini-3.1-pro", rules: [], context: undefined, promptOverride: undefined },
      targetLocale: "fr",
      contextLabel: "Free",
      translatableFrontmatter: {
        features: ["10 monthly try-on included"],
        schemaDescription: "10 monthly try-ons included.",
      },
      enBody: "",
      slugStrategy: "fixed",
    });
    assert.match(prompt, /Document: Free/);
    assert.match(prompt, /"features"/);
    assert.doesNotMatch(prompt, /## EN metadata/);
    assert.doesNotMatch(prompt, /title: free/);
    assert.doesNotMatch(prompt, /description:/);
  });

  it("adds a locale-specific slug rule for the localized strategy", () => {
    const prompt = buildPageTranslationPrompt({
      resolved: { model: "gemini-3.1-pro", rules: [], context: undefined, promptOverride: undefined },
      targetLocale: "ru",
      contextLabel: "Some post",
      translatableFrontmatter: { title: "Some post" },
      enBody: "",
      slugStrategy: "localized",
    });
    assert.match(prompt, /slug MUST be written in Russian/);
    assert.match(prompt, /never the English slug/);
  });

  it("omits the slug rule for the fixed strategy", () => {
    const prompt = buildPageTranslationPrompt({
      resolved: { model: "gemini-3.1-pro", rules: [], context: undefined, promptOverride: undefined },
      targetLocale: "ru",
      contextLabel: "Some post",
      translatableFrontmatter: { title: "Some post" },
      enBody: "",
      slugStrategy: "fixed",
    });
    assert.doesNotMatch(prompt, /slug MUST be written in/);
  });
});
