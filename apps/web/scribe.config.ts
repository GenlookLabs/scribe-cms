import { z } from "zod";
import { defineConfig, defineContentType, field } from "scribe-cms";
import { defaultLocale, locales } from "./locales";

const pageSchema = z.object({
  title: field.translatable(z.string().min(1)),
  description: field.translatable(z.string().min(1)),
  installCommand: field.structural(z.string().optional()),
});

const exampleSchema = z.object({
  title: field.translatable(z.string().min(1)),
  caption: field.translatable(z.string().min(1)),
  language: field.structural(z.enum(["ts", "bash", "mdx"]).default("ts")),
  order: field.structural(z.number().default(0)),
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
  types: [
    defineContentType({
      id: "page",
      contentDir: "pages",
      schema: pageSchema,
    }),
    defineContentType({
      id: "example",
      contentDir: "examples",
      schema: exampleSchema,
      orderBy: "slug",
    }),
    defineContentType({
      id: "changelog",
      contentDir: "changelog",
      schema: changelogSchema,
      orderBy: "-publishedAt",
    }),
  ],
});
