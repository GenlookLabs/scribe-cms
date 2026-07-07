# Inline tokens

> Status: **implemented**. MDX bodies may embed `${{...}}` tokens that resolve
> at read time to URLs, slugs, asset paths, literals, or per-document values.
> Tokens never affect translation staleness by their *value*, only by their
> presence and order.

## Motivation

MDX bodies often need a value that Scribe already knows: a link to another
entry, the public URL of an asset, a literal that must never be translated, or
a small per-document string reused in several places. Hard-coding these makes
bodies brittle (a renamed slug or moved asset silently breaks links) and
pollutes translation (a URL should never be "translated").

Inline tokens solve this: they are authored once in the EN body and resolved per
locale on read, while translation treats them as opaque, immutable placeholders.

## Syntax

A token is `${{<kind>:<args>}}`. Four kinds:

| Token | Resolves to |
| --- | --- |
| `${{static:"text"}}` | The verbatim literal `text` (a JSON string, so quotes/escapes are well defined). Never translated, identical in every locale. |
| `${{relation:<typeId>:<enSlug>:href}}` | A **link path** to the target entry (see [Relation modes](#relation-modes)). Mode is **required**. |
| `${{relation:<typeId>:<enSlug>:slug}}` | The target's **EN slug** string (a stable identifier for MDX components that load Scribe content themselves). |
| `${{asset:/web/path.webp}}` | The public asset URL (`assets.publicPath` joined to the path). |
| `${{var:key}}` | `frontmatter.vars[key]` of the same document. |

Slugs cannot contain `:`, so relation parsing is unambiguous.

Bare `${{relation:<typeId>:<enSlug>}}` (no mode suffix) is a **validation error**.

### Relation modes

Every relation token must end with `:href` or `:slug`.

| Mode | Purpose |
| --- | --- |
| `:href` | Navigable link — resolved shape depends on the consumer (see below). |
| `:slug` | Identity — always the target's EN slug string. |

**`:href` resolution by consumer**

| Consumer | `:href` resolves to |
| --- | --- |
| `createScribe()` (app runtime) | Locale-free pathname with localized slug, e.g. `/for/vestidos` — pass directly to next-intl `Link`. |
| Static `.md` export (`linkStyle: "export"`) | Full localized public path with file extension, e.g. `/es/for/vestidos.md` — matches export file layout. |

Configure export resolution via `createProject(config, { resolveInlineTokens: true, inlineLinkStyle: "export", exportLinkExtension: ".md" })`.

### Escape hatch

`$\{{` renders a literal `${{` and is never treated as a token. Use it to show
token syntax in documentation content.

## The `vars` reserved frontmatter key

`vars` is an optional `Record<string, string>` any entry may declare **without**
adding it to the type schema:

```yaml
---
title: Spring sale
vars:
  cta: Shop the sale
---

Ready? ${{var:cta}}. Limited time only.
```

`vars` is a reserved key: it is pulled out before schema validation (so a strict
schema never rejects it), it is **never** treated as a translatable field, and it
lives only on the EN document. Translated documents read `${{var:key}}` from
their EN parent's `vars` map, so there is a single source of truth.

## Hashing and translation

Tokens are extracted before hashing: each token is replaced by an inert marker
`%%1%%`, `%%2%%`, … (numbered by order of appearance), and the resulting
*placeholder body* is what gets hashed and sent to the translation model. The
markers are chosen over `{{...}}` because `{{...}}` would be parsed as a JSX
expression by remark-mdx and break MDX validation of stored translated bodies.

Consequences (all covered by tests):

- **Changing a token's VALUE** (the static text, the relation target, the asset
  path, or a `var` value) does **not** change the EN hash, so no locale goes
  stale for a value-only edit.
- **Adding, removing, or reordering tokens** **does** change the EN hash, so
  translations restage as expected.
- **A body with zero tokens** yields `placeholderBody === body` byte-for-byte, so
  shipping this feature causes no mass re-staleness.

The translation model is instructed (a built-in rule) that `%%n%%` markers are
immutable: reproduce each exactly once, never translate or renumber them, and
move them within a sentence only when grammar requires it. After a translation is
received, a post-receive check verifies every marker `%%1%%..%%N%%` appears
exactly once; a mismatch fails the row so it retries. Stored translated bodies
keep the `%%n%%` markers; they are filled at read time.

## Read-time substitution

Substitution is a runtime read-path concern, gated exactly like asset
resolution. `createScribe()` enables it with `inlineLinkStyle: "app"`; static
exports enable it with `inlineLinkStyle: "export"`. The CLI, `scribe validate`,
and the studio keep raw token syntax so they can introspect and re-hash source
bodies.

- **EN documents** have their tokens substituted in place, resolved for the
  default locale.
- **Translated documents** have their `%%n%%` markers filled using the token list
  extracted from the **current** EN body, resolved for the document's locale, so
  a relation link always points at the live localized slug even when the
  translation itself is older.

Resolution edge cases resolve to an empty string at runtime (and are flagged by
`scribe validate`): a relation whose target type has no `path` (in `:href` mode), and
a missing `var` key.

## Validation

`scribe validate` reports entry-level issues (so the studio badges pick them up):

- **Malformed token syntax** (bad JSON string, wrong arity, unknown kind): error.
- **`relation`**: unknown `typeId`, unknown `enSlug`, missing mode, or an `:href`
  relation targeting a non-routable type: error.
- **`asset`**: the file is missing on disk: error.
- **`var`**: the key is absent from the document's `vars` map, or `vars` is
  present but is not a string-to-string record: error.

Raw `${{...}}` tokens are masked to inert text before MDX body validation, so a
valid token never produces a false MDX parse error.

## Used-by and deletion

- The studio "Used by" panel and the asset browser scan bodies: `${{relation:...}}`
  tokens appear as back-references (field label `body`), and `${{asset:...}}`
  tokens register as declared asset references.
- Deleting an entry that is referenced only from another entry's **body** never
  cascades, detaches, or blocks. The deletion plan lists such references under a
  warn-only "body references" section: they will dangle and become validation
  errors after the deletion.

## Non-goals

- No per-locale static tokens (a `static` value is identical in every locale; use
  a translatable frontmatter field if you need per-locale text).
- No tokens in frontmatter (bodies only).
- No cascade or blocking from body relation references (warn only).
