# Changelog

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
