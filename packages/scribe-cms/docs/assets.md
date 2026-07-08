# Asset management

> Status: phase 1 (`field.asset()`, loader resolution, validation) is
> **implemented** as of 0.0.19. Phases 2-3 (the `scribe assets audit/clean/mv`
> CLI) are **not yet implemented**. Studio content and asset browsing has
> shipped (see [studio-content.md](./studio-content.md)). This document is the
> design source of truth for Scribe's asset system; sections are marked with
> the phase that implements them.

Scribe treats static assets (images today; files later) as first-class,
schema-declared references instead of loose strings. The system has three
layers:

1. **Schema layer** — `field.asset()` declares that a frontmatter field is a
   file reference, with constraints. *(phase 1)*
2. **Audit layer** — `scribe assets audit` builds the full reference graph and
   reports missing files, orphans, duplicates, and budget violations.
   *(phase 2)*
3. **Lifecycle layer** — `scribe assets clean` / `scribe assets mv` mutate
   files safely across every locale and the translation store. *(phase 3)*

The core principle: **components never build asset URLs by string
concatenation.** Frontmatter stores a canonical *source reference*; the
runtime resolves it to the *served URL* at load time. That single indirection
point is what lets `publicPath`, CDNs, content hashing, and a future image
preprocessing pipeline drop in as configuration instead of codebase
migrations.

---

## Configuration *(phase 1)*

The `assets` config group replaces the bare `assetsDir` (which stays supported
as a deprecated alias meaning `{ dir: assetsDir }`):

```ts
export default defineConfig({
  // ...
  assets: {
    /** Where source files live on disk, relative to rootDir. Default: "public". */
    dir: "public",
    /**
     * URL prefix the frontend serves them under. A path ("/", "/static/") or,
     * later, an absolute origin ("https://cdn.example.com/"). Default: "/".
     */
    publicPath: "/",
    /**
     * Extra Scribe-owned roots (web paths) not covered by any field.asset()
     * `dir`/`template` — e.g. directories referenced from MDX bodies.
     * Used by the audit layer; files outside managed roots are never
     * reported or touched.
     */
    managedDirs: ["/blog-images"],
    // future (NOT in phase 1 — reserved shape, do not implement):
    // process: { formats: "webp", hash: true, variants: { ... } }
  },
});
```

Naming notes:

- `publicPath` follows the webpack/Vite convention for exactly this concept.
- `managedDirs` entries are **source roots**. When a preprocessing pipeline
  exists, its output lands in a machine-owned directory that is by definition
  outside the managed source roots (and excluded from orphan scans).

## `field.asset()` *(phase 1)*

```ts
import { field } from "scribe-cms";

const garmentSchema = z.object({
  title: field.translatable(z.string()),
  productImage: field.asset({
    dir: "/try-on/garments",   // value must live under this web path
    formats: ["webp"],          // extension allowlist
    maxKB: 150,                 // size budget (warning)
    optional: false,            // default
  }),
});
```

Follows the `field.relation()` pattern: **constraints live in the options
object, not chained Zod methods**, because chaining clones the schema and
drops the symbol metadata. Implementation mirrors `RELATION_META`: an
`ASSET_META` symbol carrying `{ dir?, template?, formats?, maxKB?, optional }`,
a `getAssetMeta(schema)` introspection helper exported next to
`getRelationTarget`, and the field marked `structural` (asset paths are never
sent to the translator).

Options:

| Option | Type | Meaning |
|---|---|---|
| `dir` | `string?` | Web-path prefix the value must live under. Also declares a managed root. |
| `template` | `string?` | Derived-path template, e.g. `"/try-on/garments/{slug}/product.webp"`. `{slug}` is the entry's EN slug. When set, the frontmatter field may be omitted entirely — the loader fills it. An explicit frontmatter value overrides the template (intentional sharing between entries). A `template` implies its static prefix as a managed root; `dir` is optional alongside it. |
| `formats` | `string[]?` | Allowed extensions (lowercase, no dot). Violation = validation warning. |
| `maxKB` | `number?` | File-size budget. Violation = validation warning. |
| `optional` | `boolean?` | Field may be absent (only meaningful without `template`). Missing file for a present value is still an error. |

Value semantics:

- The frontmatter value (when present) is a **root-relative web path** into
  `assets.dir`, e.g. `/try-on/garments/denim-flare/product.webp` — same
  convention as today's image strings. No new URI scheme.
- On disk, frontmatter stores the source reference (or nothing, when
  templated). Resolved URLs exist only in runtime output — raw/static exports
  (`writeStaticRawExports`) and the translator always see source values.

## Loader resolution *(phase 1)*

When the runtime loads a document, it walks the schema for asset fields
(via `ASSET_META`, same traversal approach as `listRelationFields`) and, for
each:

1. If the frontmatter value is absent and the field has a `template`,
   materialize the path from the template (`{slug}` → EN slug).
2. Prefix `assets.publicPath` (join, avoiding double slashes; absolute-origin
   publicPath supported).

So consumers get final URLs with zero extra calls:

```ts
const garment = scribe.garment.get("denim-flare");
garment.frontmatter.productImage
// "/try-on/garments/denim-flare/product.webp"  (publicPath "/")
// "https://cdn.example.com/try-on/garments/denim-flare/product.webp"  (CDN publicPath)
```

Resolution runs **after** `mergeStructuralOntoLocale`, so every locale
document gets resolved values from the EN source.

### `scribe.assets.url(ref, opts?)` *(phase 1)*

Escape hatch for MDX body images and ad hoc cases:

```ts
scribe.assets.url("/blog-images/hero.webp");
// publicPath applied
```

`opts` is reserved for the future preprocessing pipeline (e.g.
`{ width: 800 }` returning a variant URL). **Phase 1 must accept the
parameter and throw on any unknown key** — reserving the signature so the
pipeline is additive.

## Validation *(phase 1 — upgrades `validate-assets.ts`)*

Current behavior (kept): heuristic collection of image-looking strings from
frontmatter and MDX bodies, missing file = **warning**. This continues to
cover body images and non-asset string fields with zero migration.

New behavior for declared asset fields:

- **Missing file for a required asset field = error** (blocks build, like
  dangling required relations).
- Missing file for an `optional` asset field with a present value = error too
  (optional means the *field* may be absent, not that a stated path may lie).
- Value outside the field's `dir` = error.
- Extension not in `formats` = warning.
- File larger than `maxKB` = warning.
- Messages carry field attribution:
  `garment/denim-flare: productImage → /try-on/garments/denim-flare/product.webp not found`
  (contentType, enSlug, field path — not today's generic `field: "asset"`).
- Templated fields validate the *materialized* path (file must exist even
  though frontmatter omits the value).

## Audit *(phase 2)*

`scribe assets audit [--json]` builds the reference graph — every asset-field
value (all locales) plus heuristic body/frontmatter collection — then walks
the managed roots and reports:

| Check | Level | Meaning |
|---|---|---|
| missing | error/warning | referenced, no file on disk (per phase-1 rules) |
| orphan | warning | file under a managed root referenced by nothing |
| duplicate | info | identical content hash at ≥2 paths |
| oversized | warning | over the field `maxKB` or a global budget |
| format drift | warning | extension outside the root's declared `formats` |

Content hashes are stored in the SQLite store (not recomputed per run) — this
table later doubles as the preprocessing cache/manifest.

## Lifecycle *(phase 3)*

- `scribe assets clean [--apply]` — deletes orphans. Dry-run by default.
- `scribe assets mv <from> <to>` — renames the file and rewrites every
  reference: EN docs, all locale docs, and the translation store. (Structural
  fields are merged from EN into every locale document and copied into the
  store; a hand-rename silently breaks every locale until full
  retranslation — this command is the safe path.)

## Studio *(read-only — shipped)*

The studio content and asset browsing surfaces below are implemented; see
[studio-content.md](./studio-content.md) for the shipped behavior. Same
architecture (Hono, server-rendered, no build step). Surfaces on top of schema
introspection:

- **Collection browser** — sidebar of content types; per-type entry table
  with key fields, translation status (existing status dots), validation
  issues inline.
- **Entry inspector** — fields rendered by kind: translatable (with locale
  switcher from the store), structural, relations as links (dangling = red),
  assets as image previews with path/size/dimensions. MDX body shown raw.
- **Asset browser** — managed roots as a thumbnail grid, audit badges
  (orphan/duplicate/oversized), reverse-reference list per asset.
- **Gallery view** — any type with asset fields can render its entry list as
  a card grid (QA wall for generated imagery).

## Preprocessing forward-compatibility (design commitments)

Not implemented, but phase 1 locks these in:

1. Source refs vs served URLs are distinct concepts; `url()`/loader
   resolution is the only bridge.
2. `scribe.assets.url(ref, opts?)` reserves the options bag now.
3. `managedDirs` means *source* roots; pipeline output is machine-owned and
   excluded from orphan scans.
4. Audit's content-hash table is the future processing cache.
5. `formats`/`maxKB` validate **sources**; the pipeline validates its own
   output.
