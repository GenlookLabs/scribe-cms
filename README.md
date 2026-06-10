# Scribe CMS

Typed, file-based CMS for multilingual MDX sites.

**[scribe.genlook.app](https://scribe.genlook.app)** · [`scribe-cms` on npm](https://www.npmjs.com/package/scribe-cms)

English content lives in `.mdx` files on disk. Translations live in SQLite. Schemas are Zod. A typed runtime reads everything at build time — no CMS server, no network at request time.

Works with Next.js, Astro, Remix, SvelteKit, or any Node stack.

## Install

```bash
pnpm add scribe-cms zod better-sqlite3
```

Requires Node 20+. Set `GEMINI_API_KEY` when using `scribe translate`.

## Quick start

**1. Config** — `scribe.config.ts` at your project root:

```ts
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { defineConfig, defineContentType, field } from "scribe-cms";

export default defineConfig({
  rootDir: path.dirname(fileURLToPath(import.meta.url)),
  locales: ["en", "fr"],
  types: [
    defineContentType({
      id: "blog",
      path: "/blog/{slug}",
      schema: z.object({
        title: field.translatable(z.string().min(1)),
        description: field.translatable(z.string().min(50)),
      }),
      slugStrategy: "localized",
    }),
  ],
});
```

**2. Content** — one `.mdx` file per document under `content/`. The file name is the English slug.

**3. Validate & build**

```bash
npx scribe validate
```

**4. Read at runtime**

```ts
import { createScribe } from "scribe-cms/runtime";
import config from "./scribe.config";

const scribe = createScribe(config);
const posts = scribe.blog.list("fr");
const { document } = scribe.blog.resolve("hello-world", "fr");
```

## CLI

```bash
scribe validate                # schemas, relations, translation store
scribe translate --locale fr   # translate stale/missing pages (Gemini)
scribe status                  # translation coverage
scribe studio                  # local read-only admin UI
```

## Docs

Full guides in [`packages/scribe-cms/docs`](./packages/scribe-cms/docs):

- [Getting started](./packages/scribe-cms/docs/getting-started.md)
- [Configuration](./packages/scribe-cms/docs/configuration.md)
- [Writing content](./packages/scribe-cms/docs/content.md)
- [Runtime API](./packages/scribe-cms/docs/runtime-api.md)
- [Translation](./packages/scribe-cms/docs/translation.md)

Live examples and copy-paste snippets: **[scribe.genlook.app/examples](https://scribe.genlook.app/examples)**

## Example project

[`apps/web`](./apps/web) is the source for [scribe.genlook.app](https://scribe.genlook.app) — a Next.js site that uses scribe-cms for its own content (pages, code examples, en/fr routing). Browse it on GitHub when you want a real integration to follow.

## Made by Genlook

Scribe is built by [Genlook](https://genlook.app) — AI virtual try-on for e-commerce.
