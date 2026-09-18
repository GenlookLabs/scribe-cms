# Cross-locale slug rescue

> Rendered version: [scribe.genlook.app/docs/cross-locale-rescue](https://scribe.genlook.app/docs/cross-locale-rescue)

```ts
import { createCrossLocaleRescue } from "scribe-cms/rescue";
```

Localized slug strategies create a predictable failure mode: a known slug gets
requested under the wrong locale prefix. `/es/blog/mi-articulo` exists, and one
day something asks for `/da/blog/mi-articulo`. Three things generate these URLs
in practice:

- **Locale switchers** that swap the URL's locale prefix but keep the current
  (localized) slug — framework routers don't know your per-locale slugs.
- **`pref_locale`-style redirects** that rewrite the prefix server-side, again
  without translating the slug.
- **Crawlers** exploring the locale × slug matrix from historical links; once
  discovered, search engines re-test those URLs for months.

Left alone, every one of these is a 404 for a document that exists. The rescue
turns them into a **301 to the document's URL in the requested locale** — it
never serves content on a non-canonical URL, and it never guesses: unknown or
ambiguous slugs resolve to `null` and fall through to your normal 404.

## Setup

The resolver is pure and dependency-free (no `fs`, no store access), so it can
run in edge middleware against two build-generated JSON maps you already have:

- an **alternates map** — every locale variant pathname of a document mapped to
  its full hreflang cluster (built from `runtime.alternates()` at build time);
- optionally your **content-redirect map** (source pathname → destination, as
  emitted by `buildAllContentRedirects`) — this extends the rescue to RETIRED
  slugs under a wrong prefix.

```ts
// middleware.ts (Next.js example — the resolver is framework-agnostic)
import { NextResponse, type NextRequest } from "next/server";
import { createCrossLocaleRescue, type AlternatesMap } from "scribe-cms/rescue";
import contentAlternates from "./generated/content-alternates.json";
import contentRedirects from "./generated/content-redirects.json";

const rescue = createCrossLocaleRescue(contentAlternates as AlternatesMap, {
  locales: ["en", "fr", "es", "da"],
  defaultLocale: "en",
  redirects: contentRedirects as Record<string, string>,
});

export function middleware(request: NextRequest) {
  const target = rescue.resolve(request.nextUrl.pathname);
  if (target) {
    const url = new URL(target, request.nextUrl.origin);
    url.search = request.nextUrl.search;
    return NextResponse.redirect(url, 301);
  }
  // … the rest of your middleware
}
```

Check your exact redirect map **before** the rescue if you serve one — an exact
source match should use its own destination, and `resolve()` returns `null` for
exact sources precisely so the two compose in that order.

## Resolution rules

`resolve(pathname)` works through these steps, first hit wins:

1. **Exact pathnames are left alone.** A pathname that is a key of the
   alternates map (a real page) or of the redirect map (your redirect handles
   it) returns `null`.
2. **Parse** `pathname` into locale prefix, path template prefix, and slug
   (`/da/shopify/vs/antla` → `da` + `shopify/vs` + `antla`). The path prefix is
   part of the lookup key, so a blog slug never rescues into the glossary.
3. **Live documents:** if the slug (under that prefix) belongs to exactly one
   hreflang cluster, return the cluster's pathname for the requested locale,
   falling back to the default locale's when the document has no variant there.
4. **Retired slugs:** if the slug matches redirect sources, take the default
   locale's destination (else any unambiguous one) and hop it through *its*
   cluster to the requested locale. Redirect maps legitimately repeat one slug
   under several locale prefixes with per-locale destinations, so sources are
   slotted by their locale — only a same-slug, same-locale conflict counts as
   ambiguous.
5. **Never guess.** A slug claimed by two different documents, an unknown slug,
   or a resolution that lands on the requested pathname itself all return
   `null`.

## API

```ts
type AlternateCluster = Record<string, string>; // locale (+ "x-default") → pathname
type AlternatesMap = Record<string, AlternateCluster>; // variant pathname → cluster

interface CrossLocaleRescueConfig {
  locales: readonly string[]; // all locale codes, including the default
  defaultLocale: string;      // its URLs carry no prefix
  redirects?: Record<string, string>; // optional content-redirect map
}

function createCrossLocaleRescue(
  alternates: AlternatesMap,
  config: CrossLocaleRescueConfig
): { resolve(pathname: string): string | null };
```

Index construction happens once at `createCrossLocaleRescue()` time (module
scope in middleware); `resolve()` is two `Map` lookups per request.
