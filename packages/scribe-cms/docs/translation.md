# Translation

Scribe translates the English source into every other locale with an LLM
(Gemini), and stores the results in SQLite. You never edit locale files —
you edit English, re-run `scribe translate`, and commit the store.

## What gets translated

Per document, exactly two things go to the translator:

1. Frontmatter fields marked `field.translatable()`.
2. The MDX body.

Everything else (`field.structural()`, relations, built-in fields) is copied
from the English document at load time. With `slugStrategy: "localized"` the
translator also produces a per-locale URL slug (ASCII kebab-case,
transliterated for non-Latin locales).

## Staleness tracking

Each stored translation records a SHA-256 hash of the English translatable
content it was made from. `scribe translate` re-translates a page only when:

- no translation exists for that locale (**missing**), or
- the English translatable content changed since (**stale**).

Editing a structural field, an alias, or `redirect_to` does **not** mark
translations stale — those fields aren't translated.

## Running it

```bash
export GEMINI_API_KEY=...        # also read from .env / .env.local

scribe status                     # coverage per type and locale
scribe translate                  # everything missing/stale, all locales
scribe translate --locale fr de   # specific locales
scribe translate --preset active  # a localePresets group from the config
scribe translate --type blog      # one content type
scribe translate --slug my-post   # one document
scribe translate --dry-run        # show the worklist, write nothing
scribe translate --force          # re-translate even when hashes match
scribe translate --model gemini-2.5-pro
```

Then commit `.scribe/store.sqlite`.

## Steering the translator

Project-wide defaults and per-type overrides:

```ts
export default defineConfig({
  translate: {
    context: "MyBrand is a B2B SaaS. Never translate the brand name MyBrand.",
    rules: ["Keep numbers and statistics accurate."],
    slugPreserveTerms: ["mybrand"], // kept verbatim in localized slugs
  },
  types: [
    defineContentType({
      id: "blog",
      // ...
      translate: {
        rules: [
          "Preserve all MDX/JSX component tags, props, and URLs exactly.",
          "Translate link anchor text; never change href paths.",
        ],
      },
    }),
  ],
});
```

| Option                   | Scope           | Description                                                                                                      |
| ------------------------ | --------------- | ---------------------------------------------------------------------------------------------------------------- |
| `context`                | project + type  | Brand/domain context prepended to every request (project and type contexts are concatenated).                    |
| `rules`                  | project + type  | Extra rules appended to the defaults.                                                                            |
| `prompt`                 | project or type | Replace the default system prompt entirely.                                                                      |
| `defaultModel` / `model` | project / type  | Gemini model id. Default: `gemini-2.5-pro` (also overridable via the `PROSE_GEMINI_MODEL` env var or `--model`). |
| `slugPreserveTerms`      | project         | Lowercase terms kept verbatim in localized slugs.                                                                |

## Reviewing translations

```bash
scribe history blog my-post fr    # revision timeline for one page
scribe studio                     # read-only web UI on :3600
```

The studio shows per-locale coverage, the current missing/stale worklist, and
revision history. Every translation and detected English edit is recorded in
a `revisions` table inside the store, so you can audit when and with which
model a page was translated.

## Locale presets

For incremental rollouts, name locale groups in the config and target them
with `--preset`:

```ts
localePresets: {
  active: ["fr", "es", "ja"],
  ultraLight: ["fr"],
}
```

```bash
scribe translate --preset ultraLight
```

## CLI reference

| Command                                    | Description                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------- |
| `scribe status`                            | English doc counts + per-locale translation counts.                             |
| `scribe validate`                          | Schemas, relations, aliases, slugs, store consistency. Non-zero exit on errors. |
| `scribe translate [flags]`                 | Translate missing/stale pages. Flags above.                                     |
| `scribe history <type> <en-slug> [locale]` | Revision timeline.                                                              |
| `scribe studio [--port 3600]`              | Local read-only admin UI.                                                       |

All commands accept `--config <path>` (default: `scribe.config.ts` in the
working directory).
