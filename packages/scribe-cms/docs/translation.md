# Translation

> Rendered version: [scribe.genlook.app/docs/translation](https://scribe.genlook.app/docs/translation)

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

Editing a structural field or a `_redirects.json` entry does **not** mark
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
scribe translate --strategy missing-only   # skip stale, only fill gaps
scribe translate --batch          # force batch mode (the default)
scribe translate --direct         # per-page API calls, immediate results
scribe translate --resume         # pick up pending batch jobs, submit nothing new
scribe translate --concurrency 5  # parallel requests (direct mode only)
scribe translate --model gemini-3.1-pro
```

Run in a terminal, `scribe translate` shows a live progress UI with batch job
status, per-item results, running token counts, and an estimated cost in USD.
Thinking tokens are included in the reported usage, so the estimate matches
what Google bills. Pass `--no-progress` (or run non-interactively, e.g. in CI)
for plain line-by-line logging. Without flags in a TTY, it interactively asks
for content type, locale preset, strategy, and translation mode.

Then commit `.scribe/store.sqlite`.

## Batch mode and resuming

By default the whole worklist goes through the Gemini Batch API, which halves
the token cost compared to direct calls. Scribe plans every request upfront
(one job per model, chunked for very large worklists), submits all jobs at
once, then polls them together and stores each job's results the moment it
completes. Batch jobs usually finish within minutes, but Google only
guarantees completion within 24 hours, so the command waits rather than
streaming results page by page.

Every job is recorded in the SQLite store before polling starts, together
with a snapshot of the English source each item was submitted from. That
makes runs safe to interrupt:

- Quit during polling (Ctrl+C) and nothing is lost.
- `scribe translate --resume` checks pending jobs, ingests the finished ones,
  and submits nothing new.
- Running `scribe translate` normally also picks pending jobs back up first,
  and items already in flight are never submitted twice.
- Editing an English page while its batch is in flight is fine: the result is
  stored against the snapshot it was translated from, then detected as stale
  on the next run.
- Overlapping runs are safe too. Because every run adopts pending jobs, two
  live processes can end up polling the same job; completion is claimed
  atomically in the store, so exactly one run ingests the results. The other
  reports the job as "already ingested by another scribe run" instead of
  counting it.

Prefer immediate, page-by-page results at full price? Use `--direct`, which
restores per-page API calls with `--concurrency` parallelism. Transient API
errors (429, 5xx, network drops) are retried automatically with exponential
backoff in both modes.

## Output validation

A translation is only persisted if it survives two checks:

1. The returned MDX body must parse (after normalizing escape artifacts and
   JSX attribute quoting the model sometimes gets wrong).
2. The returned frontmatter must re-validate against your full Zod schema.

A failing item fails the command with a non-zero exit code — bad model output
never reaches the store, so it can never reach production.

## Steering the translator

Project-wide defaults and per-type overrides:

```ts
export default defineConfig({
  translate: {
    context: "MyBrand is a B2B SaaS. Never translate the brand name MyBrand.",
    rules: ["Keep numbers and statistics accurate."],
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
| `defaultModel` / `model` | project / type  | Gemini model id. Default: `gemini-3.1-pro` (also overridable via the `PROSE_GEMINI_MODEL` env var or `--model`). |

Built-in rules (always applied) include: do not translate brand names unless they have a well-known local name in the target market, return MDX bodies with real line breaks (not `\\n` escapes), and fix JSX attribute quoting when values contain `"`.

## Reviewing translations

```bash
scribe history blog my-post fr    # EN snapshot timeline for one page
scribe studio                     # read-only web UI on :3600
```

Every translation links to a snapshot of the English source it was made from
(stored in the same SQLite file), so you can audit when, from what, and with
which model a page was translated. `scribe history` prints that timeline; the
studio shows per-locale coverage, the current missing/stale worklist, and
per-document detail with the snapshot alongside the stored translation.

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
| `scribe version`                           | Print installed scribe-cms version.                                           |
| `scribe validate`                          | Schemas, MDX bodies, relations, redirects, slugs, assets. Non-zero exit on errors. |
| `scribe translate [flags]`                 | Translate missing/stale pages. Flags above.                                     |
| `scribe history <type> <en-slug> [locale]` | EN snapshot timeline for one document.                                          |
| `scribe studio [--port 3600]`              | Local read-only admin UI.                                                       |
| `scribe export-static [flags]`             | Write raw MDX files for static hosting (`--out`, `--extension`, `--type`, `--locale`). |

All commands accept `--config <path>` (default: `scribe.config.ts` in the
working directory).
