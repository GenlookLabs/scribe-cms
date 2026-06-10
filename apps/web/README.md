# Example site — scribe.genlook.app

This app powers **[scribe.genlook.app](https://scribe.genlook.app)** and shows how to integrate `scribe-cms` in a real Next.js project.

Browse the source here on GitHub — it is meant to be read and copied from, not run as a standalone product.

## What it shows

- **`scribe.config.ts`** — page and example content types
- **`content/`** — MDX source files (English)
- **`src/lib/scribe.ts`** — `createScribe()` client
- **`src/app/[locale]/`** — pages rendered from scribe content
- **`src/i18n/`** + **`messages/`** — UI locale routing (next-intl) alongside scribe content locales
- **`.scribe/store.sqlite`** — generated translations (French seeded at build time)

Content copy comes from scribe. Nav labels and chrome come from next-intl — the same split you would use in production.

## Pages

| Route | Purpose |
|-------|---------|
| `/` | Home, install command, overview |
| `/examples` | Copy-paste code snippets |
| `/getting-started` | Step-by-step walkthrough |

English at `/`, French at `/fr/…`.

## Learn more

- [Scribe docs](../packages/scribe-cms/docs/getting-started.md)
- [Live site](https://scribe.genlook.app)
