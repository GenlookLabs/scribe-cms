# Example site: scribe.genlook.app

This app powers **[scribe.genlook.app](https://scribe.genlook.app)** and shows how to integrate `scribe-cms` in a real Next.js project.

Browse the source here on GitHub; it is meant to be read and copied from, not run as a standalone product.

## What it shows

- **`scribe.config.ts`**: landing, doc, blog, and changelog content types
- **`content/`**: MDX source files (English)
- **`src/lib/scribe.ts`**: `createScribe()` client
- **`src/app/[locale]/`**: pages rendered from scribe content, with JSON-LD, hreflang alternates, and per-page OG images
- **`src/i18n/`** + **`messages/`**: UI locale routing (next-intl) alongside scribe content locales
- **`scripts/export-static.mjs`**: exports every docs and blog page as raw `.md` into `public/` and generates `llms.txt` at build time
- **`scripts/translate-messages/`**: Gemini translation for the next-intl messages files (`pnpm i18n:status`, `pnpm i18n:translate`)
- **`.scribe/store.sqlite`**: generated translations via `scribe translate`. **Committed to git**; do not gitignore `.scribe/`.

Content copy comes from scribe. Nav labels and chrome come from next-intl, the same split you would use in production.

## Pages

| Route | Purpose |
|-------|---------|
| `/` | Landing page |
| `/docs` | Guides with a sectioned sidebar |
| `/blog` | Blog |
| `/changelog` | Release notes, grouped by day |
| `/llms.txt` | Generated index of the Markdown version of every page |

English at `/`, nine more locales at `/fr/…`, `/ja/…`, and so on. Docs and blog pages link their raw Markdown twin via "View as Markdown".

## Learn more

- [Scribe docs](../packages/scribe-cms/docs/README.md)
- [Live site](https://scribe.genlook.app)
