# Bodyless types & derived translatability

> Status: **implemented**. Two related features: a per-type `body: false`
> flag, and translation workflows that automatically skip types with nothing
> to translate. The core predicate is `isTypeTranslatable(type)`, exported
> alongside the other introspection helpers.

## Motivation

Reference-only collections (e.g. a `model` type whose schema is entirely
structural: enums, asset templates, names) have:

1. **No MDX body** — entries are frontmatter-only `.md` files. Nothing
   enforces that today; a stray body would be silently carried around.
2. **Nothing to translate** — yet they show up in the translation
   dashboard and `scribe translate` todos as eternally "untranslated",
   which is noise that trains humans to ignore real red badges.

## 1. `body: false` (type-level config flag)

```ts
defineContentType({
  id: "model",
  contentDir: "models",
  schema: modelSchema,
  body: false, // entries are frontmatter-only
});
```

- Default is `body: true` — fully backwards compatible.
- **Validation**: a non-empty body (anything but whitespace after
  frontmatter) on a `body: false` entry is an **error** with attribution:
  `model/andre: type "model" is frontmatter-only (body: false) but the entry has body content`.
- **Loader**: body is not parsed/compiled for these types (skip MDX work).
- **Translate pipeline**: body is never included in payloads for these
  types, in any code path.
- **Static exports**: no body/compiled output emitted.
- **Studio**: entry inspector hides the body section and shows a
  "frontmatter-only" chip instead.
- Exposed via introspection (e.g. on the resolved type object) so all
  consumers read one source of truth.

## 2. Derived translatability (no new flag)

A single core predicate, exported next to the other introspection helpers:

```ts
isTypeTranslatable(type) =
  listTranslatableFields(type.schema).length > 0 || type.body !== false
```

(A type with a body is always potentially translatable; a bodyless type is
translatable only if at least one schema field is `field.translatable`.)

Consumers of the predicate — a non-translatable type must disappear from
every translation workflow:

- `scribe translate` (and per-type/`--type` runs): skipped with one log
  line: `model: not translatable (bodyless, no translatable fields) — skipped`.
- Translation status / staleness computations: excluded from totals and
  per-locale counts (never counted as missing/stale).
- Studio translation dashboard: not listed among translate todos; the
  type's sidebar entry shows a neutral "not translatable" chip rather than
  red/empty status dots. Collection browser suppresses per-entry
  translation-status dots for these types.
- Store: no snapshot/translation rows are ever written for them.

Nuance: a **bodyless type with translatable fields** (e.g. `garment` with a
translatable `title`, `example` with `subtitle`) **stays** in translation
todos — its payload is just frontmatter-only. Only the combination
(bodyless AND zero translatable fields) drops out entirely.

## Adoption in the landing project (after implementation)

- `model` → `body: false` → fully out of translation workflows.
- `garment`, `example` → `body: false` → stay in todos, frontmatter-only
  payloads.
- `category` (structural-only schema) is a candidate for `body: false` —
  project owner's call at adoption time.

## Non-goals

- No per-entry override, no "translated manually" markers, no changes to
  how translatable frontmatter fields are sent.
