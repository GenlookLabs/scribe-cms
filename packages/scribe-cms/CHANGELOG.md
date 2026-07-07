# Changelog

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
