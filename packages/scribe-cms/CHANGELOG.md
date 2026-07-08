# Changelog

## 0.0.22 — 2026-07-07

### Changed

- Rewrote the built-in translation prompt around transcreation. The model is framed as a native-speaker copywriter producing the localized edition of the content: it carries the intent of each sentence instead of mirroring source syntax, recreates wordplay and idioms rather than rendering them literally, applies native typographic conventions (quotation marks, apostrophes, punctuation spacing), and re-reads every sentence to rewrite anything that sounds like a translation. The locale directive stays in the prompt suffix, so the shared prefix remains byte-identical across locales for prompt caching. Existing translations are not re-staled by the prompt change; use `scribe translate --force` to regenerate them.

### Fixed

- `scribe translate --dry-run` always reported $0. Dry-run items now include an estimated token count and cost derived from the actual prompt length and EN payload size, with the batch discount applied when running with `--batch`.

## 0.0.21 — 2026-07-07

### Changed

- **Breaking:** relation inline tokens now require an explicit mode suffix: `${{relation:type:enSlug:href}}` or `${{relation:type:enSlug:slug}}`. Bare `${{relation:type:enSlug}}` is rejected by the parser and `scribe validate`.
- `:href` resolves to locale-free pathnames in `createScribe()` (for framework routers such as next-intl `Link`), and to full localized public paths with a file extension in static `.md` exports (`createProject` with `inlineLinkStyle: "export"`).
- `:slug` continues to resolve to the target's EN slug string in all consumers.

## 0.0.20 — 2026-07-07

### Added

- Inline body tokens: `${{static:"text"}}`, `${{relation:type:enSlug}}` (localized URL, or the bare EN slug with a `:slug` suffix), `${{asset:/web/path}}`, and `${{var:key}}` backed by a reserved frontmatter `vars` map. Escape a literal with `$\{{`. See `docs/inline-tokens.md`.
- Hashing and translation operate on the placeholder body (tokens swapped for inert `%%n%%` markers), so editing a token's value never re-stales translations; adding, removing, or moving tokens does. Translated bodies store the markers and are filled at read time from the current EN token list, and each received translation is verified to reproduce every marker exactly once.
- Validation covers tokens: malformed spans, dangling relations, url-mode relations to non-routable types, missing asset files, and missing `vars` keys are all errors. Body relation tokens count as references in the studio "Used by" panel and warn (without blocking) on delete.
- `scribe delete <type> <en-slug> [--yes] [--dry-run]`: plans and executes entry deletion with a reference cascade, removing the EN file, its assets, and all stored translations and snapshots.
- Studio body preview: custom JSX components render as raw escaped source blocks, relation tokens become links to the target document (dangling ones show as broken chips), and assets render as actual images served straight from the assets directory. New Raw/Preview toggle on document views.
- Studio: "Used by" panel now also shows on the translation view, and lists support arrow-key navigation.

### Fixed

- Asset browser lists each asset under its most specific managed root instead of the first matching one.

## 0.0.19 — 2026-07-07

### Added

- Templated asset fields: `field.asset()` declares a root-relative web path under `assets.dir`, with constraints, existence validation, and resolution to public URLs at read time (see `docs/assets.md`).
- Bodyless content types: types can omit the MDX body entirely; translatability is derived from the schema instead of assumed.
- Studio: content browser with per-type document lists, global search, a stale-while-revalidate cache for derived data, approximate MDX preview, and validation tooltips inline on documents.

### Changed

- `localeFallbacks` is optional on the resolved config.

## 0.0.18 — 2026-07-06

### Fixed

- Blog translations no longer fail when the model hallucinates `itemList` on posts that have none in EN: response schema is scoped to the EN payload and orphan nested output is pruned before validation.
- Structural merge no longer overwrites EN fields with `undefined` from the model output.

## 0.0.17 — 2026-07-06

### Fixed

- `scribe translate --force` now includes fresh translations in the worklist (previously only skipped the per-item hash check after an empty worklist).
- `scribe translate --type` accepts comma-separated content type ids.

## 0.0.16 — 2026-07-06

### Fixed

- Always append the target locale to translation prompts, even when `translate.prompt` is set.

## 0.0.15 — 2026-07-06

### Fixed

- Failed translations are retried once automatically at the end of the run, with the validation errors fed back to the model so it can fix them. Batch runs retry as one extra batch job at the batch rate; the summary shows `+N on retry`, and anything that fails twice is logged again with its new error.

## 0.0.14 — 2026-07-06

### Added

- Automatic locale fallback chains: a regional locale with no translation of a page is served its base language before English (`fr-CA` falls back to `fr`, `zh-Hant-TW` tries `zh-Hant`, then `zh`). `resolve()` reports the served locale in `actualLocale`. On by default; set `localeFallbacks: false` to disable.

## 0.0.13 — 2026-07-06

### Added

- `scribe translate` now runs through the Gemini Batch API by default, cutting token costs by 50%. Requests are planned and submitted upfront, then polled together and ingested as each job completes.
- Resumable runs: batch jobs and their items are persisted in the SQLite store the moment they are submitted, so quitting during polling loses nothing. `scribe translate --resume` (or re-running `scribe translate`) picks pending jobs back up.
- New `--batch` and `--direct` flags choose the mode explicitly.
- Transient Gemini errors (429, 5xx, network drops) are retried automatically with exponential backoff.

### Changed

- Translation prompts restructured so the English content forms an identical prefix across all locales, letting Gemini implicit context caching discount repeated input tokens.
- Model thinking is turned down to the minimum; thinking tokens are now counted in the reported usage so cost estimates match what Google bills. Batch results are priced at the 50% batch rate.

## 0.0.12 — 2026-06-17

### Fixed

- Gemini response parsing no longer corrupts JSON whose translated body contains a Markdown code fence (e.g. ```ts blocks) — the payload is parsed directly instead of greedily extracting the first fence

### Changed

- `scribe validate` now MDX-validates EN source bodies in addition to stored translations, so invalid MDX is caught at the source

## 0.0.11 — 2026-06-16

### Added

- MDX compile validation at translation time — invalid translated bodies are rejected before upsert
- `scribe validate` checks stored translation bodies for MDX parse errors (after normalizing common Gemini escape-sequence mistakes)

### Changed

- Built-in translation rules: brand names should not be translated unless they have a well-known local name in the target market; MDX bodies must use real line breaks, not JSON `\\n` escapes
- Translated bodies are normalized on read when legacy rows contain literal `\\n` escape sequences

### Removed

- `slugPreserveTerms` project config option — use `translate.context` / `translate.rules` for brand guidance instead

## 0.0.10 — 2026-06-16

### Fixed

- `scribe validate` allows cross-type redirects where `from` and `toSlug` share the same EN slug (e.g. blog → changelog migrations)
- Redirect chain detection no longer false-positives on those same-slug cross-type entries

## 0.0.9 — 2026-06-16

### Added

- Per-content-type `_redirects.json` for slug migrations and retired documents — supports same-type (`toSlug`), cross-type (`toType` + `toSlug`), and anywhere (`toUrl`, relative or absolute) redirects
- Redirects auto-expand to translated slugs from SQLite and survive after the source MDX is deleted
- `localeRouting` config (`path-prefix` with optional `prefixDefaultLocale`, or `search-param`) and `createUrlBuilder()` for config-driven locale-aware URL generation
- `createUrlBuilder` and `UrlBuilder` exported from `scribe-cms` and `scribe-cms/runtime`

### Changed

- All internal URL generation (redirects, alternates, sitemap, runtime `url()`) routes through `createUrlBuilder()` instead of hardcoded `/${locale}` prefixing

### Removed

- Frontmatter `aliases` and `redirect_to` — migrate to `content/<type>/_redirects.json`; `scribe validate` errors if they are still present
- Alias SQLite tracking and `slug-aliases` validation helpers

## 0.0.8 — 2026-06-16

### Added

- `listRoutableTypes()` on `createScribe()` and `ScribeProject` — returns content types with a `path` template (public URLs, hreflang, sitemap)
- `isRoutableType` exported from `scribe-cms` and `scribe-cms/runtime` for apps and build scripts

## 0.0.7 — 2026-06-12

### Fixed

- Strip trailing locale-code suffixes (e.g. `-fr`, `-he`, `-ar`) from localized slugs during `scribe translate` before persisting
- `validateTranslationSlugSuffixes` now reports slug suffixes as warnings instead of build-breaking errors

### Improved

- Localized slug prompt now names the target language and requires the slug to be translated from the translated title (not the English slug), transliterating non-Latin scripts into Latin

### Added

- Translator prompt rule instructing the model not to append locale codes to slugs

## 0.0.6 — 2026-06-11

### Changed

- Replace per-locale `revisions` table with deduplicated `en_snapshots` linked via `translations.snapshot_id`
- Snapshots store EN source at translate time; many locales share one snapshot per `en_hash`
- `scribe history` and Studio show EN snapshot metadata instead of revision timeline

### Removed

- `revisions` table (auto-dropped on migrate to schema v4)
