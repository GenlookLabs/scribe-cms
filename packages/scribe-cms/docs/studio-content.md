# Studio: content management

> Status: **shipped**. The studio started as a translation dashboard (Hono,
> server-rendered HTML, no build step); it is now **content-first** — it
> browses, inspects, and **creates/edits/deletes** content, with translation
> coverage folded into its own section. Same architecture, same visual language.
> See [assets.md](./assets.md) for the asset system this consumes.

## Navigation

The activity bar (far-left rail) has exactly three destinations:

| Icon | Label | Route | What it is |
|---|---|---|---|
| ⌂ | Content | `/` | Content home — a grid of content-type cards (label, entry count, validation badge, per-card "+ New"). The card links to the type's collection browser. |
| ⇄ | Translations | `/translations` | Tabbed section: **Coverage** (per-locale + per-type coverage tables) and **Staleness** (the stale/missing worklist). |
| ▤ | Assets | `/assets` | Asset browser (only shown when the project manages assets). |

The sidebar keeps the global search box and the content-type tree; each tree
row reveals a subtle "+" on hover linking to that type's **new-entry** form.
Per-entry translation status lives inside the inspector under a **Translations**
tab (`/types/:typeId/:enSlug?tab=translations`), not in a separate route.

The former translation routes 301-redirect to their new homes: `/dashboard` →
`/translations`, `/staleness` → `/translations?tab=staleness`, `/type/:id` →
`/types/:id`, and `/type/:id/doc/:enSlug` → `/types/:id/:enSlug?tab=translations`.

## Goal

Humans can **see, verify, and edit** everything Scribe manages without opening
files by hand: browse collections, inspect entries with resolved relations and
asset previews, spot bad or missing imagery at a glance, answer "what uses
this?" before changing anything, and create or edit an entry through a
schema-derived form.

Files stay the source of truth: **agents and humans edit files**, and the
studio is one of the humans — every studio write is a plain file write (one
`.md`/`.mdx` frontmatter file per entry, plus image files under the assets
dir). A studio session's git diff looks exactly like a hand edit. No database
writes, no hidden state. New entries are always created as `.mdx`; existing
`.md` files stay readable and editable in place.

## Decisions (locked)

| Question | Decision |
|---|---|
| Deployment | **Local dev only** (`scribe studio`, localhost, no auth, live working-tree reads) |
| MDX body preview | **Rendered approximation** — markdown rendered properly; unknown JSX components as labeled boxes with their props |
| Search | **Field filters per type + global full-text search** |
| Reverse references | **Everywhere** — relations and assets both get "used by" lists |

## Non-goals

Translation triggering, auth/multi-user, true MDX component rendering,
deployment/snapshot builds. Translation coverage/staleness views still exist,
now consolidated under `/translations` and the inspector's Translations tab.
Slug **renaming** is out of scope (edit shows the slug read-only).

## Mutations (creation, editing, deletion)

Creation and editing shipped as a v2 decision — the studio is now a first-class
editor, not just a reviewer. Every mutation is a localhost-only, POST-only route
(no CSRF token; same trust model as a local dev tool) that ends in plain file
writes and a `studioCache.invalidate()` + redirect:

| Action | Route |
|---|---|
| New entry | `GET`/`POST /types/:typeId/new` |
| Edit entry | `GET`/`POST /types/:typeId/:enSlug/edit` |
| Delete entry | `GET`/`POST /types/:typeId/:enSlug/delete` (see [deletion.md](./deletion.md)) |

The collection browser toolbar has a **+ New entry** button; the entry
inspector header has **Edit** next to Delete.

### The form

The form is generated from the schema (`studio/entry-forms.ts`), one control per
top-level field, in declaration order, each with its `.describe()` text as muted
help:

- `string` → text input, `number` → number input, `boolean` → checkbox,
  enum → `<select>` (optional enums get an empty option).
- relation (single) → `<select>` of target entries; relation (multiple) →
  checkbox list. Option value is the target's EN slug.
- asset (single) → file input. A **templated** field shows its computed
  destination path (materialized from the current slug, live-updated) and keeps
  the frontmatter key omitted (the loader fills it); a **dir**-based field
  writes `{slug}.{ext}` and stores the web path in frontmatter.
- asset (multiple) → multi file input; on edit, existing items render as
  thumbnails each with a "remove" checkbox. The final array is the kept existing
  items (original order) followed by new uploads (file order); new files are
  named `{slug}-{n}.{ext}` continuing after the highest existing index.
- Nested objects / object-arrays that don't map to a widget fall back to a
  labeled **YAML textarea**, parsed on submit.
- body (unless `body: false`) → a monospace textarea.

On **create** the slug input auto-derives (slugified) from the first
translatable string field until you edit it by hand; it is checked against the
type's existing EN slugs and `_redirects.json` aliases. On **edit** the slug is
read-only.

### Writing (`studio/entry-write.ts`)

The submission is validated **before anything is written**: the type's Zod
schema (`safeParse`), relation targets exist, and each uploaded file's extension
is in `formats` with size within `maxKB` (rejected inline — no conversion). On
any failure the form re-renders with every value preserved and per-field error
messages. Only after full validation does it write image files, then the entry
file. On edit it preserves frontmatter keys the schema doesn't manage (e.g.
`publishedAt`, `vars`) and leaves the body bytes untouched unless the body
textarea changed.

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
- **Translations tab** (`?tab=translations`, translatable types only) — the
  per-locale translation detail: status, model, timestamp, the stored (or
  EN-merged) frontmatter, the translated body (raw/preview), and the EN
  snapshot captured at translation time. Details stays the default view.

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

Each step shipped usable on its own. A later pass made the studio content-first:
`/` became the content home, the translation dashboard/staleness/overview
collapsed into the tabbed `/translations` section, and per-entry translation
status moved into the inspector's Translations tab (legacy routes 301-redirect).
