# Runtime API

> Rendered version: [scribe.genlook.app/docs/runtime-api](https://scribe.genlook.app/docs/runtime-api)

```ts
import { createScribe } from "scribe-cms/runtime";
import config from "./scribe.config";

const scribe = createScribe(config);
```

`createScribe()` returns a typed client with one accessor per content type
(`scribe.blog`, `scribe.author`, …) plus `scribe.sitemap()`. All reads are
synchronous and in-memory: content is loaded once, cached, and (in
development) revalidated when files or the translation store change.

The client is plain Node — no framework dependency. It works the same in
Next.js, Astro, Remix, SvelteKit, or a build script; the page examples below
use Next.js conventions (`generateStaticParams`, `permanentRedirect`) purely
as illustrations.

Documents have this shape — `frontmatter` is typed from your Zod schema:

```ts
{
  slug: string;        // slug in this document's locale
  enSlug: string;      // English parent slug (== slug for EN docs)
  locale: string;
  frontmatter: { ... };
  content: string;     // raw MDX body
  publishedAt?: string;
  updatedAt?: string;
  noindex: boolean;
}
```

## Reading

### `list(locale?, options?)`

All documents for a locale (default: the default locale), sorted by the
type's `orderBy`.

```ts
scribe.blog.list("fr");
scribe.blog.list("fr", { limit: 3 });
scribe.blog.list("fr", { orderBy: "slug" });   // per-call override
```

Returns `[]` for a locale with no documents.

### `get(slug, locale?)`

Exact slug lookup in one locale. No fallback, no redirect handling. Returns
the document or `null`.

### `resolve(slug, locale)`

The full request-path resolution — use this in pages:

```ts
const r = scribe.blog.resolve(slug, locale);
// {
//   document: BlogDoc | null,
//   actualLocale: string,        // "en" when EN fallback kicked in
//   shouldRedirectTo?: string,   // 301 target (wrong-locale slug correction)
//   canonicalPath?: string,      // locale-aware pathname for the document
// }
```

Handles, in order: direct hit → wrong-locale slug redirect → locale fallback
chain (on by default; see
[Configuration](./configuration.md#locale-fallback-chains)) → English fallback
(when `indexFallback: "en"`). When a fallback locale serves the page,
`actualLocale` is that locale and slug correction is chain-aware. Slug
migrations and retired documents are handled
by `_redirects.json` rules in your proxy/static redirect map, not by
`resolve()`. A typical page handler (Next.js shown; map to your framework's
redirect/404 primitives):

```ts
const resolved = scribe.blog.resolve(slug, locale);
if (resolved.shouldRedirectTo) permanentRedirect(resolved.shouldRedirectTo);
if (!resolved.document) notFound();
```

## Routing helpers

### `staticParams(options?)`

Every `{ locale, slug }` pair to prerender — drop it into your framework's
static-paths hook (Next.js `generateStaticParams`, Astro `getStaticPaths`,
SvelteKit `entries`, …):

```ts
export function generateStaticParams() {
  return scribe.blog.staticParams();
}

// Restrict locales (e.g. an OG-image route that only supports Latin scripts):
scribe.blog.staticParams({ locales: ["en", "fr", "de"] });
```

For a locale without a translation, the prerendered slug comes from the first
locale fallback chain locale that has one (then the English slug), so
prerendered URLs match what `resolve()` serves. See
[Configuration](./configuration.md#locale-fallback-chains).

### `alternates(doc)`

The hreflang map for a document: locale → relative path, for every locale
that has a translation (the default locale is always included):

```ts
scribe.blog.alternates(doc);
// { en: "/blog/hello-world", fr: "/fr/blog/bonjour-le-monde" }
```

Feed it to your hreflang tags — e.g. Next.js `metadata.alternates.languages`
or hand-rendered `<link rel="alternate">` elements (wrap values with your own
`absolute()` if you need full URLs).

### `translation(doc, targetLocale)`

The same document in another locale, or `null` if untranslated. Callers
usually fall back to the document they already have:

```ts
const frDoc = scribe.blog.translation(doc, "fr") ?? doc;
```

### `url(slug, locale)`

Builds a pathname from the type's `path` template:

```ts
scribe.blog.url("hello-world", "fr");  // "/fr/blog/hello-world"
```

`staticParams`, `alternates`, and `url` throw for reference-only types
(no `path`).

## Relations

### `related(doc, field, locale?)`

Dereferences a `field.relation()` frontmatter field into the target type's
document(s). The return type is inferred from the schema:

```ts
scribe.blog.related(doc, "author");        // AuthorDoc           (required single)
scribe.vertical.related(doc, "blogSlug");  // BlogDoc | null      (optional single)
scribe.glossary.related(doc, "terms");     // GlossaryDoc[]       (multiple)
```

- Dereferences in `locale ?? doc.locale`, falling back to the English
  document when the target isn't translated.
- A **required** relation never returns `null`: `scribe validate` blocks the
  build on dangling required relations, and `related()` throws if one slips
  through.
- Optional relations return `null`; multiple relations silently drop missing
  targets.
- Only top-level schema fields are exposed (nested relations are still
  validated, but dereference them manually).

## Assets

Fields declared with [`field.asset()`](./configuration.md#fieldassetoptions)
resolve to final served URLs on read: `assets.publicPath` is applied and
templated paths are materialized (`{slug}` → EN slug), so components consume
`doc.frontmatter.productImage` directly with no URL building. Resolution runs
only through `createScribe()`; raw/static exports and the translator always see
source values.

```ts
const garment = scribe.garment.get("denim-flare");
garment.frontmatter.productImage;
// "/try-on/garments/denim-flare/product.webp"  (publicPath "/")
// "https://cdn.example.com/try-on/garments/denim-flare/product.webp"  (CDN publicPath)
```

### `scribe.assets.url(ref)`

Escape hatch for MDX body images and ad hoc paths — applies `publicPath` to a
root-relative web path:

```ts
scribe.assets.url("/blog-images/hero.webp"); // publicPath applied
```

The second argument is reserved for a future preprocessing pipeline; passing any
key throws in phase 1. See [Asset management](./assets.md).

## Sitemap

```ts
const entries = await scribe.sitemap({
  baseUrl: "https://example.com",
  typeDefaults: {
    blog: { priority: 0.7, changeFrequency: "monthly" },
  },
});
```

Returns plain JSON entries (`url`, `lastModified`, `changeFrequency`,
`priority`, hreflang `alternates.languages` including `x-default`) — the
shape matches Next.js `MetadataRoute.Sitemap`, and serializes directly into
sitemap XML for any other stack. One entry per English document across all
routable types; skips `noindex` and redirect source slugs from `_redirects.json`.

Options: `baseUrl` (required), `contentTypes`, `typeDefaults`, `resolveUrl`,
`resolvePathname`, `excludeNoindex` (default true), `includeXDefault`
(default true).

## Introspection

Beyond the per-type accessors, the client exposes the resolved config:

```ts
scribe.config;              // resolved ScribeConfig
scribe.getType("blog");     // one resolved content type
scribe.listTypes();         // all content types
scribe.listRoutableTypes(); // only types with a path template
```

Useful for generic tooling — e.g. iterating every routable type to build
navigation or feeds. The programmatic counterparts of the CLI also ship on the
main entry (`generateSitemap`, `translateWorklist`/`translatePage`,
`serializeMdx`, `findConfigPath`/`resolveConfig`) for build scripts that need
more control than the commands offer.

## Redirects

For statically-exported redirect rules (`_redirects.json`, cross-locale
slugs), use the build-script entry:

```ts
// scripts/generate-redirects.ts — run before the app build
import {
  buildAllContentRedirects,
  createProject,
  createUrlBuilder,
  loadConfigSync,
} from "scribe-cms";

const config = loadConfigSync();
const project = createProject(config);
const urlBuilder = createUrlBuilder(project.config);
const rules = buildAllContentRedirects(project, {
  prefixedLocales: urlBuilder.prefixedLocales,
});
// [{ source, destination, permanent: true }, ...]
// Matches Next.js redirect config directly; map to nginx rules, _redirects,
// vercel.json, or your framework's equivalent as needed.
```

## Static raw exports

For LLM/crawler-friendly raw MDX files served as static assets (e.g.
`/blog/my-post.mdx`), use the build-script entry:

```ts
// scripts/generate-static-mdx.mjs — run before the app build
import { buildStaticRawExports, createProject, loadConfigSync } from "scribe-cms";

const config = loadConfigSync();
const project = createProject(config);
const exports = buildStaticRawExports(project, { extension: ".mdx" });
// [{ relativePath, urlPath, locale, typeId, enSlug, source }, ...]
// relativePath: "blog/my-post.mdx" or "fr/glossary/term.mdx" (from public/ root)
```

Or use the CLI / write helper:

```bash
scribe export-static --out public
```

```ts
import { writeStaticRawExports, createProject, loadConfigSync } from "scribe-cms";

writeStaticRawExports(createProject(loadConfigSync()), { outDir: "public" });
```

`getStaticExportRoots(project)` returns managed directory roots to clean
before writing (e.g. `blog/`, `fr/blog/`). Documents listed as redirect sources
in `_redirects.json` are skipped when `excludeRedirected` is true (default).
`noindex` documents are included unless `excludeNoindex` is set.

## Escape hatch

`scribe.<type>.load()` returns the raw
`Map<locale, { bySlug, byEnSlug }>` index. Prefer `list`/`get`/`resolve` —
`load()` exists for tooling and unusual access patterns.

## Framework integration

Scribe is framework-agnostic — the runtime is plain Node and works in any
server-rendered or statically-built stack. Three rules apply everywhere:

1. Import from **`scribe-cms/runtime`** in app code (it excludes the
   CLI / translator code paths from bundler tracing); use `scribe-cms`
   in build scripts.
2. Keep **`better-sqlite3`** (a native module) and Scribe external to your
   bundler — e.g. Next.js `serverExternalPackages`, Vite/Astro
   `ssr.external`, esbuild `external`.
3. Cache the client in a module singleton:

```ts
// src/lib/scribe.ts
import { createScribe } from "scribe-cms/runtime";
import type { ScribeClient } from "scribe-cms/runtime";
import config from "../../scribe.config";

let cached: ScribeClient<typeof config> | null = null;
export function getScribe() {
  return (cached ??= createScribe(config));
}
```

Gate builds on content health: `"build": "scribe validate && <framework build>"`.

### Next.js example

```ts
// next.config.ts
const nextConfig = {
  serverExternalPackages: ["better-sqlite3", "scribe-cms", "scribe-cms/runtime"],
  // Required on Vercel — Scribe reads content/ and .scribe/ at runtime.
  outputFileTracingIncludes: {
    "/**": ["./content/**/*", "./.scribe/**/*"],
  },
  // Also required on Vercel: Scribe's runtime file reads make the tracer
  // sweep Next's webpack build cache into every serverless function,
  // blowing past the 250 MB limit. The cache is never needed at runtime.
  outputFileTracingExcludes: {
    "/**": ["./.next/cache/**"],
  },
};
```

`staticParams()` plugs into `generateStaticParams()`, `alternates()` into
`metadata.alternates.languages`, `scribe.sitemap()` into `app/sitemap.ts`, and
`buildAllContentRedirects()` into `redirects()`.
