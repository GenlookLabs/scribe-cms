# Writing content

## Files

One document = one `.mdx` (or `.md`) file in the type's folder:

```
content/
  blog/
    hello-world.mdx        → slug "hello-world"
    _redirects.json        → redirect rules for this type (optional)
  authors/
    jane.mdx               → slug "jane"
```

- The **file name is the English slug**. Slugs are lowercase kebab-case.
- Only English files exist on disk — locale versions live in the SQLite store.
- Files whose name starts with `_` or an uppercase letter (e.g.
  `PUBLISHING.md`) are ignored, so you can keep notes next to your content.

## Frontmatter

Frontmatter is YAML, validated against the type's Zod schema:

```mdx
---
title: "Hello, world"
description: "A long enough description for the schema."
author: jane
publishedAt: "2026-01-15"
updatedAt: "2026-02-01"
---

Body is MDX.
```

Schema validation follows your Zod schema: with a plain `z.object` unknown
keys are silently stripped; use `.strict()` if you want typos in field names
to fail validation.

## Built-in frontmatter fields

These are available on **every** content type without declaring them in the
schema (declaring them yourself is an error — they are extracted before your
schema runs):

| Field | Type | Description |
| --- | --- | --- |
| `publishedAt` | ISO date | Publication date. |
| `updatedAt` | ISO date | Last significant update. Defaults to `publishedAt`. Drives sitemap `lastModified`. |
| `noindex` | boolean | Excluded from the sitemap; expose it as a robots meta tag in your pages. |
| `canonicalPath` | string | Manually override the canonical URL path. |

Locale documents inherit `publishedAt`, `updatedAt`, `noindex`, and
`canonicalPath` from their English parent — translators can't change them.

Every loaded document also carries `slug`, `enSlug` (the English parent slug;
equal to `slug` for English documents), `locale`, `frontmatter`, and `content`.

## Redirects: `_redirects.json`

Per content-type folder, add an optional `_redirects.json` file to declare
slug migrations and retired documents. Redirects survive after you delete the
source MDX — translated source slugs are expanded automatically from SQLite.

```json
{
  "redirects": [
    { "from": "hello-world", "toSlug": "hello-scribe" },
    { "from": ["old-a", "old-b"], "toSlug": "hello-scribe" },
    { "from": "moved-post", "toType": "glossary", "toSlug": "virtual-try-on" },
    { "from": "retired-page", "toUrl": "/pricing" },
    { "from": "retired-ext", "toUrl": "https://example.com/app" }
  ]
}
```

Three redirect kinds (exactly one target per entry):

| Kind | Fields | Description |
| --- | --- | --- |
| Same-type | `toSlug` | Target EN slug in the same content type. URL built from this type's `path`, localized per locale. |
| Cross-type | `toType` + `toSlug` | Target EN slug in another routable content type (must have a `path`). |
| Anywhere | `toUrl` | Root-relative same-site path or absolute external URL, identical for every locale. |

- `from`: EN slug(s) only. Translated source slugs are resolved from SQLite.
- Optional `permanent` (default `true`).

### Agent workflow: retire or rename a document

1. Add an entry to `content/<type>/_redirects.json`.
2. Delete (or rename) the source MDX.
3. Run `scribe validate` then rebuild. Redirect rules are emitted by
   `buildAllContentRedirects()` for your proxy or Next.js config.

`scribe validate` checks: JSON schema, routable source/target types, live
target documents, no duplicate `from` slugs, and no `from` slug with a live MDX
file still on disk.

## Validation

```bash
scribe validate
```

Checks, per English file: schema parse, built-in field shapes, your
`crossValidate` hook, relation integrity (dangling required relation = error,
dangling optional relation = warning), `_redirects.json` rules, localized-slug
suffix rules, and missing image assets when `assetsDir` is set.

Exit code is non-zero when any error is found — run it before your build.
