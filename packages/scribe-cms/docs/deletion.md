# Entry deletion & reference cascade

> Status: **implemented** (2026-07-07). Two related features: entry deletion
> (CLI + studio) with a configurable reference cascade, and arrow-key prev/next
> navigation in the studio inspector.

## Motivation

Deleting an entry today means hand-deleting the EN file, hunting down every
doc that references its slug, remembering the store rows, and cleaning up its
asset files. Reference-heavy collections (model/garment/example) make this
error-prone: a forgotten reference is a broken relation at build time, a
forgotten asset is an orphan file, forgotten store rows are zombie
translations.

## Config surface

Both knobs live on the field that owns the pointer, so the schema reads as a
single source of truth:

```ts
// On the REFERENCING field — what happens to THIS doc when its TARGET is deleted:
field.relation("example", { multiple: true, onTargetDelete: "detach" })
// "restrict" (default) | "detach" | "cascade"

// On the asset field — what happens to the file when ITS OWN doc is deleted:
field.asset({ template: "/x/{slug}.webp", onDelete: "delete" })
// "delete" (default) | "keep"
```

- `restrict` — deletion of the target is **blocked**; the plan lists the
  referencing docs.
- `detach` — the reference is removed: the slug is dropped from
  multiple-relation arrays, optional single relations are cleared. The
  referencing EN file is rewritten (frontmatter only; body untouched; minor
  YAML reformatting from re-serialization is acceptable). A **required single
  relation can never be detached** — such a doc blocks the deletion and the
  plan says so explicitly.
- `cascade` — the referencing doc is deleted too, recursively (cycle-safe).
  The plan shows the full transitive tree before anything happens.
- Asset `delete` — the file is removed with the doc. A non-templated
  (shared-path) asset file is only removed when no doc **outside the deletion
  set** still references the same path.
- Relations are structural (EN-only, merged at build), so detaching never
  touches the store and never changes the page EN hash — no spurious
  retranslation.

## Impact plan (shared core)

One module computes the plan; CLI and studio both render and execute it.

```
buildDeletionPlan(config, typeId, enSlug) => {
  roots:    [doc]                                  // the requested deletion
  cascades: [{ typeId, enSlug, via }]              // transitive, cycle-safe
  detaches: [{ typeId, enSlug, fieldPath, removedSlug }]
  blocked:  [{ typeId, enSlug, fieldPath, reason }] // restrict / required-single
  assets:   [{ path, ownerEnSlug, action }]
  store:    [{ typeId, enSlug, translations, snapshots }]  // per-locale counts
}
```

Execution refuses to run while `blocked` is non-empty. Everything in the plan
is computed up front; execution performs exactly the plan (files, store rows,
asset files, detach rewrites) and nothing else.

## CLI

```
scribe delete <type> <enSlug> [--yes] [--dry-run]
```

Prints the plan (grouped: cascades, detaches, assets, store counts, blockers),
then asks `y/N` unless `--yes`. `--dry-run` prints the plan and exits 0.
A blocked plan exits 1 after printing the blockers.

## Studio

- A small danger-styled **Delete** button in the entry inspector toolbar.
- `GET /types/:typeId/:enSlug/delete` renders the confirmation page: the full
  plan in sections with counts; a red confirm button (form `POST` to the same
  URL) and a cancel link back to the inspector. A blocked plan shows the
  blockers and no confirm button.
- `POST` executes the plan and redirects to the collection view.
- This is the studio's first mutating route; it stays a localhost dev tool
  (no auth/CSRF beyond POST-only).

## Arrow-key navigation (inspector)

- `ArrowLeft` / `ArrowRight` navigate to the previous / next entry of the same
  type, in the collection's default order (same as the collection table). No
  wrap-around. Current query params (locale, `body=preview`) are preserved.
- Keys are ignored while focus is in an input/textarea/select.
- Server computes prev/next URLs and renders visible `‹` / `›` toolbar buttons
  (title shows the target slug); a ~10-line inline script binds the keys. This
  is the studio's first client-side JS — inline, no build step.

## Adoption in the landing project (after implementation)

- `vertical.examples`, `vertical.featuredExample`, `platform.examples`,
  `platform.featuredExample` → `onTargetDelete: "detach"`.
- `example.model`, `example.garment` → `onTargetDelete: "cascade"` (deleting a
  model or garment deletes its example docs; their result images go too via
  asset `delete`; the deleted examples then transitively detach from any
  vertical/platform lists).

## Non-goals

- No trash/undo (git is the safety net).
- No bulk deletion, no locale-only deletion.
- No per-entry override of the field-level config.
