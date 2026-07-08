# translate-messages

> Adapted from FittingRoom's `apps/landing/scripts/translate-messages`. Kept as
> close to upstream as possible for easy syncs. Local changes: locales list and
> names (see `core.mjs`), stale detection also flags values identical to the
> English source (this repo seeds untranslated keys with the English string),
> Scribe CMS product context and an em-dash ban in the prompt (`context.mjs`),
> and a Scribe-specific `glossary.json`.

A zero-dependency Node CLI that localizes the next-intl UI strings in
`apps/web/messages/*.json` with Gemini. It uses only Node built-ins (`fetch`,
`util.parseArgs`, `fs`, `crypto`, `child_process`), so there is nothing to
install beyond Node itself.

## Setup

1. Put your Gemini key in `apps/web/.env` (this is the same `GEMINI_API_KEY`
   that `scribe translate` reads):

   ```
   GEMINI_API_KEY=your-key-here
   ```

   The loader also checks `apps/web/.env.local` first. A key already present in
   `process.env` always wins.

2. No other tooling is required. To find the source files that use each
   translation namespace, the tool uses `rg` (ripgrep) when a real binary is on
   `PATH`, and otherwise falls back to `git grep` (including untracked files),
   which is always available inside the monorepo.

## Commands

Run from `apps/web`:

```bash
node scripts/translate-messages/cli.mjs status
node scripts/translate-messages/cli.mjs translate
```

Or via the package scripts:

```bash
pnpm i18n:status
pnpm i18n:translate
```

When passing flags through pnpm, separate them with `--` so pnpm does not
swallow them (or call `node scripts/translate-messages/cli.mjs` directly):

```bash
pnpm i18n:translate -- --dry-run --locale fr
```

### status

Prints, with no API calls, how many keys are stale per locale plus the lockfile
per-model breakdown:

```
EN entries: 1179 keys across 43 namespaces
     fr:    0 empty / untranslated  by model: gemini-3.1-pro=1179
     es:   10 empty / untranslated  by model: gemini-3.1-pro=1169
```

A key is stale when its locale value is empty. next-intl content-hashes each
message key from the EN string, so a non-empty value is by construction in sync
with the current EN. EN drift is impossible.

### translate

```bash
node scripts/translate-messages/cli.mjs translate [flags]
```

Flags:

| flag | meaning |
| --- | --- |
| `--locale <l>` | Limit to a locale. Repeatable. Default: every non-EN locale. |
| `--model <name>` | Gemini display name. Default `gemini-3.1-pro`. |
| `--dry-run` | Print the pre-flight estimate and stop. No paid call. |
| `--force` | Treat every key of the selected locales as stale (full re-localization). |
| `--retranslate-models <m>` | Also retranslate keys locked by this model. Repeatable. |
| `--mode auto\|live\|batch` | Delivery mode. Default `auto`. |
| `--concurrency N` | Live-mode parallel requests. Default 8. |
| `--thinking low\|medium\|high` | Thinking level for live calls. Default `low`. |
| `--poll-timeout <minutes>` | Batch poll timeout for the whole poll loop. Default 120. |
| `--abandon-batch` | Cancel every pending batch job and clear the state file. |
| `--dump-prompts <file>` | Write every prompt to a file (pairs with `--dry-run`). |

#### Interactive locale picker

When `translate` runs with no `--locale` flags and both stdin and stdout are a
TTY, it first prints the stale-key count per locale and prompts for a selection.
You can answer `all`, a comma or space separated list of locale codes
(`fr, de`), or press Enter for all. An unknown code re-asks once, then falls
back to all. In a non-TTY context (CI, piped input) the picker is skipped and
every non-EN locale is selected, exactly as before.

#### Re-localizing after prompt or glossary changes

`--force` marks every key of the selected locales as stale, so the whole set is
re-localized through the current model. Use it after editing the prompt template
or `glossary.json` so existing strings pick up the new wording:

```bash
node scripts/translate-messages/cli.mjs translate --force --locale fr
```

Because a bare `--force` (no `--locale`) would re-pay for all 15 locales, it is
guarded: it requires an explicit `--locale` selection, or an interactive
confirmation. In a non-TTY context, `--force` with no `--locale` is refused.

## How modes work

- `auto` (default): fewer than 50 total stale keys runs `live` (interactive,
  results applied immediately). 50 or more runs `batch` (async, 50% cheaper).
- `live`: a promise pool sends one request per batch unit, ordered so that all
  locales of the same namespace set run back to back. This maximizes Gemini's
  implicit prompt caching, since everything before the `# Target locale` line
  is identical across locales. Each result is validated and written to disk
  immediately, so a crash loses at most one unit.
- `batch`: submits **one batch job per locale**, all concurrently at the start
  (each locale's JSONL contains only that locale's requests; at most 15 locales,
  well under the API's 100-concurrent-job limit). It then polls every job in a
  single loop every 30 seconds, showing one line per locale with its job state
  and elapsed time plus a header with running/succeeded/failed counts. As soon
  as a locale's job succeeds, its results are downloaded, validated, and written
  to disk, and that locale is removed from the state file. A failed, expired, or
  cancelled job records an error for its locale but does not block the others.
  State is persisted to `.cache/pending-batch.json` as
  `{ version: 2, model, createdAt, jobs: { <locale>: { name, keys } } }`. Rerun
  the same command while jobs are pending and it resumes polling every still
  pending job (already-applied locales are gone from the file); the older
  single-job state format is still read and resumed correctly.
  `--abandon-batch` cancels every pending job and clears the file. On
  `--poll-timeout`, the still-pending locales are printed and rerunning resumes
  them. The process exits 0 when all locales applied cleanly, 1 if any locale
  failed or any translations were rejected.

## Cost model

Pricing (USD per 1M tokens) is per display name. `gemini-3.1-pro` bills input at
$2.00 and output at $12.00 below 200k prompt tokens, and $4.00 / $18.00 above
that tier. Batch mode applies a flat 50% discount to every rate. Unknown models
show a placeholder dash as the cost so a wrong number is never displayed. Every run prints a
pre-flight estimate table with exact input tokens (from the free `countTokens`
endpoint) before any paid call is made.

## glossary.json

`glossary.json` is the source of truth for terminology consistency, and you are
meant to edit it. It has three sections:

- `brand`: terms that are never translated (Genlook, Shopify, and so on). This
  list is locale independent.
- `terms`: a map from a recurring product phrase to its established translation
  per locale. Only the target locale's column is injected into the prompt. A
  missing locale means there is no established form yet, so the model chooses.
- `style`: a single global style note (plain string) that applies to every
  locale. It is injected into the shared header of every prompt as a short
  `# Style` section, so it also extends the cacheable locale-neutral prefix.
  Use it for guidance that holds across all languages, for example when to
  prefer English loanwords over translated equivalents, or how to pick
  formality. Set it to an empty string to disable it. After editing it, re-run
  with `--force --locale <l>` to re-localize a locale under the new guidance.

## Lockfiles and retranslate-models

Each translation is recorded in `messages/.locks/<locale>.lock.json` as
`{ "<ns>.<key>": { model, translated_at } }`. This is not used for drift
detection, it records which model produced each string. When a new Gemini
generation ships and you want to upgrade older translations in place, run:

```bash
node scripts/translate-messages/cli.mjs translate --retranslate-models gemini-2.5-pro
```

Every key locked by `gemini-2.5-pro` is then re-flagged as stale and sent
through the current model.

## Dossier cache

For each namespace the tool builds a source-code dossier: the files that use the
namespace, the classified call sites (heading, button label, placeholder, and so
on) in page order, and one short real-code excerpt. This gives the model the UX
context for each string. The dossier is cached in `.cache/context.json`, keyed
by a hash of the involved files' paths, sizes, and modification times, so it is
recomputed only when the source changes. The `.cache` directory is gitignored.
