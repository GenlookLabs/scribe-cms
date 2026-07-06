import { z } from "zod";
import { defineConfig, defineContentType, field } from "scribe-cms";
import { defaultLocale, locales } from "./locales";

// Nested arrays are NOT wrapped in field.structural: that would make the whole
// subtree English-only. Left unmarked, the inner field.translatable markers are
// picked up per item (steps.*.title, features.*.body, ...).
const landingSchema = z.object({
  title: field.translatable(z.string().min(1)),
  description: field.translatable(z.string().min(1)),
  installCommand: field.structural(z.string()),
  ctaDocs: field.translatable(z.string().min(1)),
  ctaGithub: field.translatable(z.string().min(1)),
  howHeading: field.translatable(z.string().min(1)),
  steps: z.array(
    z.object({
      title: field.translatable(z.string().min(1)),
      body: field.translatable(z.string().min(1)),
    }),
  ),
  featuresHeading: field.translatable(z.string().min(1)),
  features: z.array(
    z.object({
      title: field.translatable(z.string().min(1)),
      body: field.translatable(z.string().min(1)),
    }),
  ),
  contributeHeading: field.translatable(z.string().min(1)),
  contributeBody: field.translatable(z.string().min(1)),
});

const docSchema = z.object({
  title: field.translatable(z.string().min(1)),
  description: field.translatable(z.string().min(1)),
  order: field.structural(z.number()),
});

const changelogSchema = z.object({
  version: field.structural(z.string().regex(/^\d+\.\d+\.\d+$/)),
});

export default defineConfig({
  // Relative: the CLI resolves it against this file's directory, the runtime
  // against process.cwd(). Never derive it from import.meta.url — bundlers
  // inline that to the build machine's path, which doesn't exist on Vercel.
  rootDir: ".",
  locales: [...locales],
  defaultLocale,
  localePresets: {
    all: ["fr", "pt-BR", "zh-CN", "es", "de", "ja", "ar", "it", "ru"],
  },
  translate: {
    context: [
      "Scribe (scribe-cms) is a typed, file-based CMS for multilingual MDX sites.",
      "Never translate code identifiers, CLI commands, package names, or file paths.",
      "Keep scribe-cms and Genlook brand names in English.",
    ].join("\n"),
  },
  types: [
    defineContentType({
      id: "landing",
      contentDir: "landing",
      schema: landingSchema,
    }),
    defineContentType({
      id: "doc",
      contentDir: "docs",
      schema: docSchema,
      orderBy: (a, b) => a.frontmatter.order - b.frontmatter.order,
    }),
    defineContentType({
      id: "changelog",
      contentDir: "changelog",
      schema: changelogSchema,
      orderBy: "-publishedAt",
    }),
  ],
});
