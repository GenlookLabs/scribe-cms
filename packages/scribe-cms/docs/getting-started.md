# Getting started

> Rendered version: [scribe.genlook.app/docs/getting-started](https://scribe.genlook.app/docs/getting-started)

## Install

```bash
pnpm add scribe-cms zod better-sqlite3
```

Requirements: Node 20+, Zod v4. Scribe is framework-agnostic — it works with
any Node-based stack. `better-sqlite3` is a native module, so keep it
external to your bundler (see
[Runtime API → Framework integration](./runtime-api.md#framework-integration)).

## 1. Create `scribe.config.ts`

Put it at your project root:

```ts
import { z } from "zod";
import { defineConfig, defineContentType, field } from "scribe-cms";

const blogSchema = z.object({
  title: field.translatable(z.string().min(1)),
  description: field.translatable(z.string().min(50).max(250)),
  author: field.relation("author"),
  tags: field.structural(z.array(z.string()).default([])),
});

const authorSchema = z.object({
  name: field.structural(z.string().min(1)),
});

export default defineConfig({
  rootDir: ".", // relative to this file (CLI) / process.cwd() (runtime)
  locales: ["en", "fr", "de"],
  types: [
    defineContentType({
      id: "blog",
      path: "/blog/{slug}",
      schema: blogSchema,
      slugStrategy: "localized",
      orderBy: "-publishedAt",
    }),
    defineContentType({
      id: "author",
      contentDir: "authors",
      schema: authorSchema,
    }),
  ],
});
```

`defineConfig` and `defineContentType` are identity functions that preserve
literal types — they are what make `scribe.blog` and `related(doc, "author")`
fully typed later.

## 2. Write content

```
content/
  blog/
    hello-world.mdx
  authors/
    jane.mdx
```

```mdx
---
title: "Hello, world"
description: "A first post that says hello to the world, at length, because the schema demands fifty characters."
author: jane
publishedAt: "2026-01-15"
---

The body is MDX. **Markdown** and <Components /> both work.
```

The file name (`hello-world`) is the English slug. `publishedAt` is one of the
[built-in fields](./content.md#built-in-frontmatter-fields) available on every
type.

## 3. Validate

After `pnpm install`, the `scribe` CLI is on your PATH (same as `next`):

```bash
pnpm scribe validate
pnpm scribe status
```

Wire it in front of your build:

```jsonc
// package.json
{
  "scripts": {
    "build": "scribe validate && <your framework build>",
  },
}
```

## 4. Read content

```ts
import { createScribe } from "scribe-cms/runtime";
import config from "./scribe.config";

const scribe = createScribe(config);

const posts = scribe.blog.list(); // BlogDoc[], newest first
const { document } = scribe.blog.resolve("hello-world", "fr");
const author = scribe.blog.related(document!, "author"); // AuthorDoc, non-null
```

`document.frontmatter` is typed from your Zod schema. See the
[Runtime API](./runtime-api.md) for the full surface.

## 5. Translate

```bash
export GEMINI_API_KEY=...   # or put it in .env
npx scribe translate --locale fr
```

Scribe finds every page that is missing or stale in French, translates the
fields you marked `field.translatable()`, and stores the result in
`.scribe/store.sqlite`. **Commit that directory** — never add `.scribe/` to
`.gitignore`. Details in [Translation](./translation.md).
