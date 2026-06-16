/** App-code entry — use instead of `scribe-cms` in bundled server code (Next.js, Astro, …) to keep CLI/translator code paths out of bundler tracing. */
export { createScribe } from "./create-scribe.js";
export { isRoutableType, createUrlBuilder } from "./i18n/build-url.js";
export type { UrlBuilder } from "./i18n/build-url.js";
export type { LocaleRoutingConfig } from "./core/types.js";
export type {
  ScribeConfigInput,
  ScribeConfig,
  ScribeDocument,
  ContentTypeInput,
  ContentTypeConfig,
  ContentTypeRuntime,
  ListOptions,
  OrderBy,
  StaticParam,
  ResolvedDocument,
  Scribe,
  InferDocMap,
  InferDocFromTypeConfig,
  ScribeClient,
  ScribeDocs,
  ScribeDocOf,
} from "./core/types.js";
export type { SitemapEntry, SitemapChangeFrequency } from "./sitemap/types.js";
