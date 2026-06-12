# Changelog

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
