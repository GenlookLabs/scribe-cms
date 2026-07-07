# Scribe

Typed, file-based CMS for multilingual MDX. English source files on disk, locale translations in SQLite, Zod schemas, Gemini-powered translation, and a framework-agnostic runtime API.

Scribe has no framework dependency — it reads files and SQLite in-process and works with any Node-based stack (Next.js, Astro, Remix, SvelteKit, a static-site script, …). Examples in these docs use Next.js, but nothing about Scribe is Next-specific.

**Docs:** [scribe.genlook.app/docs](https://scribe.genlook.app/docs) · [Getting started](./docs/getting-started.md) · [Configuration](./docs/configuration.md) · [Writing content](./docs/content.md) · [Runtime API](./docs/runtime-api.md) · [Translation](./docs/translation.md)

## Install

```bash
pnpm add scribe-cms zod better-sqlite3
```

Set `GEMINI_API_KEY` when using `scribe translate`.

## Quickstart

### 1. Define the config

```ts
// scribe.config.ts (at your project root)
import { z } from "zod";
import { defineConfig, defineContentType, field } from "scribe-cms";

const blogSchema = z.object({
  title: field.translatable(z.string().min(1)),
  description: field.translatable(z.string().min(50)),
  author: field.relation("author"),
  tags: field.structural(z.array(z.string()).default([])),
});

const authorSchema = z.object({
  name: field.structural(z.string().min(1)),
});

export default defineConfig({
  rootDir: ".", // relative to this file (CLI) / process.cwd() (runtime)
  // contentDir: "content"            (default)
  // store: ".scribe/store.sqlite"     (default)
  locales: ["en", "fr"],
  // defaultLocale: "en"              (default)
  // localeFallbacks: true            (default: regional variants fall back to their base language, e.g. pt-BR to pt; set false to disable)
  types: [
    defineContentType({
      id: "blog",
      path: "/blog/{slug}",            // routable: gets URLs, sitemap, redirects
      schema: blogSchema,
      slugStrategy: "localized",       // translated slugs per locale (default: "fixed")
      orderBy: "-publishedAt",         // default sort for list()
    }),
    defineContentType({
      id: "author",                    // no path: reference-only type
      contentDir: "authors",           // default would be "author"
      schema: authorSchema,
    }),
  ],
});
```

Content lives in `content/blog/*.mdx` and `content/authors/*.mdx`. The file
name is the EN slug. Frontmatter is validated against the schema; the built-in
fields `publishedAt`, `updatedAt`, `noindex`, and `canonicalPath` are available
on every type without declaring them. Redirects live in `content/<type>/_redirects.json`.

### 2. Field markers

- `field.translatable(schema)` — sent to the translator for each locale.
- `field.structural(schema)` — EN-only; merged from EN into every locale document.
- `field.relation(typeId, options?)` — EN slug reference(s) to another type.
  Constraints go in the options (not chained Zod methods):
  `field.relation("glossary", { multiple: true, max: 8, optional: true })`.
  Validated by `scribe validate`, dereferenced with `related()`.
- `field.asset(options?)` — a file reference (web path into `assets.dir`):
  `field.asset({ dir: "/try-on/garments", formats: ["webp"], maxKB: 150 })`.
  Validated by `scribe validate`, resolved to a served URL at load time.

### 3. Read content

```ts
import { createScribe } from "scribe-cms/runtime"; // bundler-safe entry; plain "scribe-cms" works in scripts
import config from "./scribe.config";

const scribe = createScribe(config);

// Lists & lookups
scribe.blog.list("fr");                       // sorted docs for a locale
scribe.blog.get("my-post");                   // exact slug lookup, no fallback
const r = scribe.blog.resolve("my-post", "fr"); // cross-locale slug fix + fallback chain + EN fallback
// r = { document, actualLocale, shouldRedirectTo?, canonicalPath? }

// Routing helpers
scribe.blog.staticParams();                   // all { locale, slug } pairs to prerender
scribe.blog.alternates(doc);                  // hreflang map: locale → path
scribe.blog.translation(doc, "fr");           // the same doc in another locale (or null)
scribe.blog.url(doc.slug, "fr");              // path from the type's template

// Relations (fully typed from the schema)
scribe.blog.related(doc, "author");           // AuthorDoc — non-null, validated at build time

// Sitemap
await scribe.sitemap({ baseUrl: "https://example.com" }); // entries with hreflang alternates
```

Typed accessors (`scribe.blog`, `scribe.author`, …) and `related()` return types
are inferred from the config — no codegen.

### 4. Translate & validate

```bash
scribe status                  # EN docs + translation coverage
scribe validate                # schemas, MDX bodies, relations, redirects, sqlite consistency
scribe translate --locale fr   # translate stale/missing pages (Gemini Batch API, 50% token cost)
scribe translate --preset active --strategy missing-only
scribe translate --direct      # per-page API calls at full price, immediate results
scribe translate --resume      # pick up pending batch jobs from an interrupted run
scribe translate --dry-run     # show the worklist without calling the API
scribe history blog my-post fr # EN snapshot timeline for one document
scribe studio                  # read-only local admin UI
scribe export-static           # raw MDX files for static hosting / crawlers
```

Translated output is checked before it is stored: the returned MDX body must
parse and the frontmatter must re-validate against your Zod schema, so a bad
model response fails the command instead of reaching production. Interactive
runs show live progress with token counts and an estimated cost in USD.

Translation runs through the Gemini Batch API by default (half the token
cost). Jobs are persisted in the store as soon as they are submitted, so
interrupting a run is safe: the next `scribe translate` (or `--resume`) picks
pending jobs back up without submitting anything twice.

Translations are stored in `.scribe/store.sqlite` keyed by a hash of the EN
translatable content, so `scribe translate` only re-translates what changed.
**Commit `.scribe/`** — do not add it to `.gitignore`.

## Framework integration

Scribe runs anywhere Node does — see
[Runtime API → Framework integration](./docs/runtime-api.md#framework-integration).
The short version:

- Use `scribe-cms/runtime` in app code, `scribe-cms` in build scripts/CLI.
- Keep `better-sqlite3` (a native module) external to your bundler
  (e.g. Next.js `serverExternalPackages`, Vite `ssr.external`).
- Gate builds: `"build": "scribe validate && <your framework build>"`.
- Redirects: `buildAllContentRedirects(project)` produces
  `{ source, destination, permanent }` rules from `_redirects.json` and
  cross-locale slugs — map them to your framework's redirect config.

**Site & examples:** [scribe.genlook.app](https://scribe.genlook.app) · [Example Next.js app](https://github.com/GenlookLabs/scribe-cms/tree/main/apps/web)
