# Configuration

> Rendered version: [scribe.genlook.app/docs/configuration](https://scribe.genlook.app/docs/configuration)

Everything lives in one file, `scribe.config.ts`, exporting `defineConfig({...})`.
Both the runtime (`createScribe`) and the CLI (which discovers
`scribe.config.ts` in the working directory) read the same file.

## Project options

```ts
export default defineConfig({
  rootDir: ".",
  contentDir: "content",            // default
  store: ".scribe/store.sqlite",     // default
  locales: ["en", "fr", "de"],
  defaultLocale: "en",              // default
  localeRouting: { strategy: "path-prefix", prefixDefaultLocale: false },
  // localeFallbacks: true           (default: pt-BR falls back to pt)
  localePresets: { active: ["fr"] },
  translate: { /* see Translation docs */ },
  types: [ /* defineContentType(...) */ ],
});
```

| Option | Default | Description |
| --- | --- | --- |
| `rootDir` | — (required) | Project root. Keep it relative (usually `"."`): the CLI resolves it against the config file's directory, `createScribe` against `process.cwd()`. Don't build it from `import.meta.url` — bundlers inline that path at build time, which breaks on serverless hosts like Vercel. Relative `contentDir`/`store` resolve against it. |
| `contentDir` | `"content"` | Directory containing one folder per content type. |
| `store` | `".scribe/store.sqlite"` | SQLite translation store. **Commit it — do not gitignore `.scribe/`.** |
| `assetsDir` | — | **Deprecated** alias for `assets.dir`. Static assets root (e.g. `"public"`). |
| `assets` | — | Asset system config: `{ dir, publicPath, managedDirs }`. Passing `assets: {}` opts in with defaults (`dir: "public"`, `publicPath: "/"`, `managedDirs: []`). Enables declared-asset validation and load-time URL resolution. See [Asset management](./assets.md). |
| `locales` | — (required) | All locales, including the default one. |
| `defaultLocale` | `"en"` | Canonical source locale. Must appear in `locales`. |
| `localeRouting` | `{ strategy: "path-prefix", prefixDefaultLocale: false }` | How locale markers appear in generated URLs. `path-prefix` prepends `/{locale}` (omit for default locale when `prefixDefaultLocale` is false). `search-param` appends `?{param}={locale}` for non-default locales. |
| `localeFallbacks` | `true` | Regional locales fall back to their base language when a translation is missing (`pt-BR` to `pt`). Set `false` to disable. See [Locale fallback chains](#locale-fallback-chains). |
| `localePresets` | — | Named locale groups for `scribe translate --preset <name>`. |
| `translate` | — | Project-wide translation defaults ([Translation](./translation.md)). |
| `types` | — (required) | Content type definitions. |

Configs are validated up front: an unknown `defaultLocale`, duplicate type
ids, or a malformed `path` template throw immediately with a clear message.

## Content type options

```ts
defineContentType({
  id: "blog",
  schema: blogSchema,
  path: "/blog/{slug}",
  contentDir: "blog",          // default: the id
  slugStrategy: "localized",   // default: "fixed"
  indexFallback: "en",         // default: "en" if path is set, else "none"
  orderBy: "-publishedAt",     // default: "slug"
  label: "Blog",               // default: capitalized id (studio UI only)
  body: true,                  // default: true; set false for frontmatter-only types
  crossValidate: (data, ctx) => [],
  translate: { /* per-type overrides */ },
})
```

| Option | Description |
| --- | --- |
| `id` | Unique id. Becomes the typed accessor (`scribe.blog`) and the default `contentDir`. |
| `schema` | Zod object schema for the frontmatter, with [field markers](#field-markers). |
| `path` | URL template with exactly one `{slug}` (e.g. `/blog/{slug}`). Omit for **reference-only** types (authors, categories) that have no pages of their own. |
| `contentDir` | Folder under the project `contentDir` holding this type's `.mdx` files. |
| `slugStrategy` | `"fixed"`: every locale uses the English slug. `"localized"`: the translator produces a per-locale slug (`/fr/blog/bonjour-le-monde`). |
| `indexFallback` | What `resolve()` returns when a locale has no translation: `"en"` serves the English document (with `actualLocale: "en"`), `"none"` returns nothing. |
| `orderBy` | Default sort for `list()`: `"slug"`, `"publishedAt"`, `"-publishedAt"`, `"updatedAt"`, `"-updatedAt"`, or a comparator `(a, b) => number` over fully-typed documents. |
| `body` | Whether entries carry an MDX body. Default `true`. Set `false` for **frontmatter-only** reference types (e.g. a structural `model` catalog): the loader skips the body, `scribe validate` errors on any non-empty body, translation payloads never include a body, and the studio shows a "frontmatter-only" chip. A `body: false` type whose schema has **no** `field.translatable()` fields is derived non-translatable and drops out of every translation workflow (see [Bodyless types](./bodyless-types.md) and [Translation](./translation.md#derived-translatability)). |
| `crossValidate` | Extra validation run by `scribe validate`, receiving the parsed (typed) frontmatter. Return `{ field, message, level }[]`. |
| `translate` | Per-type translation prompt/rules/model ([Translation](./translation.md)). |

## Field markers

Every schema field is one of three kinds. Unmarked fields default to
**structural**.

```ts
import { field } from "scribe-cms";

const schema = z.object({
  // Sent to the translator, stored per locale:
  title: field.translatable(z.string().min(1)),

  // English-only; copied from the EN document into every locale:
  heroImage: field.structural(z.string().optional()),

  // English slug reference(s) to another content type:
  author: field.relation("author"),
  relatedPosts: field.relation("blog", { multiple: true, max: 4, optional: true }),
});
```

### `field.relation(typeId, options?)`

| Option | Default | Description |
| --- | --- | --- |
| `multiple` | `false` | The field is an array of slugs. |
| `optional` | `false` | The field may be omitted. `related()` then returns `null` (single) or skips missing items (multiple). |
| `min` / `max` | — | Item count bounds (`multiple: true` only). |
| `onTargetDelete` | `"restrict"` | What happens to this document when the referenced target is deleted (`scribe delete`): `"restrict"` blocks the deletion, `"detach"` removes the reference, `"cascade"` deletes this document too. See [Entry deletion](./deletion.md). |

Constraints go in the options object — **not** chained Zod methods. Chaining
(`.max(8)`, `.optional()`) clones the schema and would strip the relation
metadata.

Relations always store **English slugs**, are checked by `scribe validate`
(a dangling required relation is a build-blocking error; a dangling optional
one is a warning), and are dereferenced at runtime with
[`related()`](./runtime-api.md#relations).

### `field.asset(options?)`

Declares a frontmatter field as a file reference (a root-relative web path
into `assets.dir`) instead of a loose string. Structural (EN-only), validated
by `scribe validate`, and resolved to a served URL at load time.

```ts
const schema = z.object({
  productImage: field.asset({ dir: "/try-on/garments", formats: ["webp"], maxKB: 150 }),
});
```

| Option | Description |
| --- | --- |
| `dir` | Web-path prefix the value must live under. Also declares a managed root. |
| `template` | Derived-path template, e.g. `"/try-on/garments/{slug}/product.webp"` (`{slug}` is the EN slug). When set, the field may be omitted (the loader fills it); an explicit value overrides it. Cannot be combined with `multiple`. |
| `formats` | Allowed extensions (lowercase, no dot). Violation is a warning. |
| `maxKB` | File-size budget. Violation is a warning. |
| `optional` | The field may be absent (only meaningful without `template`). A present value whose file is missing is still an error. |
| `multiple` | The field holds an **array** of web paths instead of one. Each element is validated (existence, `dir`, `formats`, `maxKB`) and prefixed with `publicPath`. |
| `min` / `max` | Array length bounds (`multiple: true` only). Out-of-range counts are errors. |
| `onDelete` | `"delete"` (default) removes the file when its document is deleted; `"keep"` leaves it. A shared (non-templated) path is only removed when no document outside the deletion set still references it. See [Entry deletion](./deletion.md). |

```ts
// A field holding several images:
const schema = z.object({
  gallery: field.asset({ dir: "/products", formats: ["webp"], multiple: true, min: 1, max: 6 }),
});
// gallery in frontmatter is an array of web paths; the runtime resolves each element.
```

`multiple: true` is the API for many-assets — **not** `z.array(field.asset())`,
which mis-detects (introspection unwraps arrays and would read the inner
single-asset brand). Constraints go in the options object, not chained Zod
methods. Requires the `assets` config group to be enabled. See
[Asset management](./assets.md) for the full design.

### Field descriptions

Any field may carry help text with Zod's native `.describe()` — including the
schemas returned by `field.asset()`, `field.relation()`, `field.translatable()`,
and `field.structural()`. The text surfaces in the studio inspector (muted line
under the field key) and as the tooltip on the collection filter labels.

```ts
const schema = z.object({
  status: field.structural(z.enum(["draft", "live"])).describe("Publication state"),
  gallery: field.asset({ dir: "/products", multiple: true }).describe("Up to 6 product shots"),
});
```

The description may sit on the inner schema or on an outer `.optional()` wrapper;
Scribe checks both (outer wins). `.describe()` returns a schema clone, but Scribe
brands both the schema and its shared `_def`, so a description never disturbs
relation/asset detection.

## Locale fallback chains

By default, a regional locale with no translation of a document is served its
base language before the default locale: each locale tries the successively
shorter prefixes of its own tag that are also in `locales`, so `fr-CA` falls
back to `fr`, and `zh-Hant-TW` tries `zh-Hant`, then `zh`. Set
`localeFallbacks: false` to disable. The default locale is never part of a
chain; it stays the final fallback, governed by the type's `indexFallback`.

Fallbacks apply to `resolve()` (the served locale is reported in
`actualLocale`, and slug redirects use the fallback locale's slug) and
`staticParams()` (prerendered slugs match what `resolve()` serves). They
deliberately do **not** apply to `get()`, `list()`, `translation()`,
`alternates()`, or the sitemap: those stay exact-match.

## Typed client types

For app-side type aliases, derive everything from the config:

```ts
import type { ScribeClient, ScribeDocs } from "scribe-cms/runtime";
import config from "./scribe.config";

type MyScribe = ScribeClient<typeof config>;
type BlogDoc = ScribeDocs<typeof config>["blog"];
```
