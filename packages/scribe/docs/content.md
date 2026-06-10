# Writing content

## Files

One document = one `.mdx` (or `.md`) file in the type's folder:

```
content/
  blog/
    hello-world.mdx        → slug "hello-world"
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
| `aliases` | string[] | Old slugs for this document (see below). Max 20. |
| `redirect_to` | string | Retire this document with a redirect to a successor path (must match the type's `path` template). |
| `canonicalPath` | string | Manually override the canonical URL path. |

Locale documents inherit `publishedAt`, `updatedAt`, `noindex`, and
`canonicalPath` from their English parent — translators can't change them.

Every loaded document also carries `slug`, `enSlug` (the English parent slug;
equal to `slug` for English documents), `locale`, `frontmatter`, and `content`.

## Renaming a document: aliases

To rename `hello-world` to `hello-scribe` without breaking links:

1. Rename the file to `hello-scribe.mdx`.
2. Add the old slug to `aliases`:

```yaml
aliases:
  - hello-world
```

`resolve("hello-world", locale)` now returns
`shouldRedirectTo: "/blog/hello-scribe"` (localized when a translation exists),
and `buildAllContentRedirects()` emits a permanent redirect rule for it.
Existing translations are re-attached to the new slug. `scribe validate`
catches alias collisions and circular chains.

## Retiring a document: `redirect_to`

To delete a page in favor of another one, keep a stub file containing only:

```yaml
---
redirect_to: /blog/the-newer-better-post
---
```

The document stops rendering and resolves to a permanent redirect instead. It
is excluded from `list()` consumers' sitemaps via `generateSitemap()`.

## Validation

```bash
scribe validate
```

Checks, per English file: schema parse, built-in field shapes, your
`crossValidate` hook, relation integrity (dangling required relation = error,
dangling optional relation = warning), alias collisions and redirect chains,
localized-slug suffix rules, and store consistency (stale translations are
reported as warnings).

Exit code is non-zero when any error is found — run it before your build.
