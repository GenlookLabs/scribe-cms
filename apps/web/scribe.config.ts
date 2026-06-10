import path from "node:path";
import { fileURLToPath } from "node:url";
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

export default defineConfig({
  rootDir: path.dirname(fileURLToPath(import.meta.url)),
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
  ],
});
