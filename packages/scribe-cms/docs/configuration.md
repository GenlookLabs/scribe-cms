# Configuration

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
| `locales` | — (required) | All locales, including the default one. |
| `defaultLocale` | `"en"` | Canonical source locale. Must appear in `locales`. |
| `localeRouting` | `{ strategy: "path-prefix", prefixDefaultLocale: false }` | How locale markers appear in generated URLs. `path-prefix` prepends `/{locale}` (omit for default locale when `prefixDefaultLocale` is false). `search-param` appends `?{param}={locale}` for non-default locales. |
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

Constraints go in the options object — **not** chained Zod methods. Chaining
(`.max(8)`, `.optional()`) clones the schema and would strip the relation
metadata.

Relations always store **English slugs**, are checked by `scribe validate`
(a dangling required relation is a build-blocking error; a dangling optional
one is a warning), and are dereferenced at runtime with
[`related()`](./runtime-api.md#relations).

## Typed client types

For app-side type aliases, derive everything from the config:

```ts
import type { ScribeClient, ScribeDocs } from "scribe-cms/runtime";
import config from "./scribe.config";

type MyScribe = ScribeClient<typeof config>;
type BlogDoc = ScribeDocs<typeof config>["blog"];
```
