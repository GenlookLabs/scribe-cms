# Studio: content management (read-only)

> Status: **requirements** — agreed scope for the studio revamp. The current
> studio is a translation dashboard (Hono, server-rendered HTML, no build
> step); this document adds read-only content management on top of it. Same
> architecture, same visual language. See [assets.md](./assets.md) for the
> asset system this consumes.

## Goal

Humans can **see and verify** everything Scribe manages without opening
files: browse collections, inspect entries with resolved relations and asset
previews, spot bad or missing imagery at a glance, and answer "what uses
this?" before changing anything.

Agents and humans **edit files**; the studio is where humans **review**.

## Decisions (locked)

| Question | Decision |
|---|---|
| Deployment | **Local dev only** (`scribe studio`, localhost, no auth, live working-tree reads) |
| MDX body preview | **Rendered approximation** — markdown rendered properly; unknown JSX components as labeled boxes with their props |
| Search | **Field filters per type + global full-text search** |
| Reverse references | **Everywhere** — relations and assets both get "used by" lists |

## Non-goals (v1)

Content editing, translation triggering, image upload, auth/multi-user, true
MDX component rendering, deployment/snapshot builds. The existing translation
views stay as they are.

Entry **deletion** shipped later and is the exception: a studio Delete button
posts to `POST /types/:typeId/:enSlug/delete` (the studio's first mutating
route). Field editing remains out of scope. See [deletion.md](./deletion.md).

## Surfaces

### 1. Collection browser — `/types/:typeId`

- Sidebar lists every content type from `listTypes()`, with entry counts and
  an aggregate issue badge (validation errors/warnings in that type).
- Entry table per type: slug, a schema-derived selection of key fields
  (first few scalar fields; enums and relations rendered as chips),
  translation-status dots (reuse the existing component), and per-entry
  validation badges.
- **Field filters** derived from schema introspection, as query params
  (shareable URLs, server-rendered):
  - enum fields → select (e.g. `status=placeholder`, `kind=segment`)
  - relation fields → select of target slugs (e.g. `vertical=dresses`,
    `model=brooke`)
  - booleans → toggle; strings → contains
- **Gallery toggle**: any type whose schema has at least one asset field can
  switch the table to a card grid — card = primary asset (first asset field)
  as image, slug, key fields, status/validation badges. Filters apply
  identically. This is the QA wall for generated imagery.

### 2. Entry inspector — `/types/:typeId/:enSlug`

Fields rendered by introspected kind:

- **translatable** — value with a locale switcher (data from the store);
  EN-fallback clearly marked when the locale has no translation.
- **structural** — plain value.
- **relation** — clickable link to the target entry; dangling = red badge.
- **asset** — image preview + resolved URL, file size, dimensions; missing
  file = red badge.
- **Reverse references** — "Used by" section listing every entry (any type)
  whose relations point here.
- **Body** — rendered approximation: markdown rendered; JSX components as
  labeled boxes (component name + props table, children rendered inside).
  Uses the already-present remark-parse/remark-mdx dependencies; no new
  runtime deps. A "view on site" link for routable types (path template +
  locale).

### 3. Asset browser — `/assets`

- One thumbnail grid per managed root (`getManagedRoots()`).
- Per asset: preview, path, size, dimensions, and **"referenced by"** —
  every entry+field pointing at it (computed live from the in-memory
  runtime; no store needed in v1).
- Badges: unreferenced (orphan candidate), missing-but-referenced,
  oversized (field `maxKB`), format drift. v1 computes these live;
  when phase-2 `scribe assets audit` lands with stored content hashes,
  duplicate detection joins the list.

### 4. Global search — `/search?q=`

Full-text over EN frontmatter values and MDX bodies (simple in-memory token
index built at load; no external deps). Results grouped by type, linking
into the inspector. Slugs and asset paths are searchable.

## Cross-cutting

- **Indexes** (back-refs, search, filters) are built from the in-memory
  runtime at request time or cached per content-change tick — the existing
  dev revalidation (file + store watching) invalidates them. Local-only
  means no persistence concerns.
- **Validation surfacing**: run the validators once per content tick; badge
  entries and types. The studio never blocks on validation — it displays it.
- **Progressive enhancement**: server-rendered HTML with query-param state;
  minimal inline JS only where it clearly pays (filter form auto-submit,
  gallery/table toggle). No client framework, no build step.
- **Generic only**: nothing in the studio may special-case a Genlook content
  type. The try-on QA wall must fall out of "gallery view + enum filters +
  relations as chips", not bespoke code.

## Build order

1. Collection browser + entry inspector with relations, assets, and
   reverse references (introspection + runtime only). **Implemented.**
2. Field filters + gallery view. **Implemented.**
3. Asset browser. **Implemented.**
4. Global search. **Implemented** — `GET /search?q=` (`studio/search.ts`), a
   sidebar search form on every page, case-insensitive substring match over EN
   slugs, every frontmatter value, and raw MDX bodies. Results are grouped by
   type with a `<mark>`-highlighted snippet, capped at 20 hits per type.
5. MDX rendered approximation. **Implemented** — the entry inspector body has
   Raw (default) / Preview tabs (`?body=preview`); `renderMdxApprox`
   (`studio/mdx-preview.ts`) renders Markdown + GFM and shows unknown JSX
   components as labeled prop boxes. Escape-first, with a preformatted fallback
   so malformed input never crashes.

Each step ships usable on its own; the existing translation dashboard keeps
working throughout.
