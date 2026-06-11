# Changelog

## 0.0.6 — 2026-06-11

### Changed

- Replace per-locale `revisions` table with deduplicated `en_snapshots` linked via `translations.snapshot_id`
- Snapshots store EN source at translate time; many locales share one snapshot per `en_hash`
- `scribe history` and Studio show EN snapshot metadata instead of revision timeline

### Removed

- `revisions` table (auto-dropped on migrate to schema v4)
