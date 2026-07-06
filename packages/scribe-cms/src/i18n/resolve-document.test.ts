import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ContentTypeConfig, ScribeDocument } from "../core/types.js";
import { resolveLocalizedDocument } from "./resolve-document.js";

/** Build a minimal document. `enSlug` defaults to `slug` (for EN docs). */
function doc(locale: string, slug: string, enSlug = slug): ScribeDocument {
  return {
    slug,
    enSlug,
    locale,
    noindex: false,
    frontmatter: {},
    content: "",
  };
}

/** Build a locale → { bySlug, byEnSlug } index map from documents grouped by locale. */
function indexOf(
  docsByLocale: Record<string, ScribeDocument[]>,
): ReadonlyMap<
  string,
  { bySlug: ReadonlyMap<string, ScribeDocument>; byEnSlug: ReadonlyMap<string, ScribeDocument> }
> {
  const map = new Map<
    string,
    { bySlug: Map<string, ScribeDocument>; byEnSlug: Map<string, ScribeDocument> }
  >();
  for (const [locale, docs] of Object.entries(docsByLocale)) {
    const bySlug = new Map<string, ScribeDocument>();
    const byEnSlug = new Map<string, ScribeDocument>();
    for (const d of docs) {
      bySlug.set(d.slug, d);
      byEnSlug.set(d.enSlug, d);
    }
    map.set(locale, { bySlug, byEnSlug });
  }
  return map;
}

const routable: ContentTypeConfig = {
  id: "blog",
  schema: undefined as never,
  path: "/blog/{slug}",
  contentDir: "blog",
  label: "Blog",
  slugStrategy: "localized",
  indexFallback: "en",
};

const nonRoutable: ContentTypeConfig = {
  ...routable,
  path: undefined,
  indexFallback: "none",
};

describe("resolveLocalizedDocument", () => {
  describe("without fallbacks", () => {
    const all = indexOf({
      en: [doc("en", "hello")],
      fr: [doc("fr", "bonjour", "hello")],
    });

    it("serves a direct hit in the requested locale", () => {
      const r = resolveLocalizedDocument("bonjour", "fr", "en", all, routable);
      assert.equal(r.document?.slug, "bonjour");
      assert.equal(r.actualLocale, "fr");
    });

    it("redirects a wrong-locale slug to the corrected slug", () => {
      const r = resolveLocalizedDocument("hello", "fr", "en", all, routable);
      assert.equal(r.document, null);
      assert.equal(r.shouldRedirectTo, "/fr/blog/bonjour");
    });

    it("serves EN when the locale has no translation (EN-slug request)", () => {
      const noFr = indexOf({ en: [doc("en", "solo")] });
      const r = resolveLocalizedDocument("solo", "fr", "en", noFr, routable);
      assert.equal(r.document?.slug, "solo");
      assert.equal(r.actualLocale, "en");
    });

    it("returns null for an unknown slug", () => {
      const r = resolveLocalizedDocument("nope", "fr", "en", all, routable);
      assert.equal(r.document, null);
      assert.equal(r.shouldRedirectTo, undefined);
    });
  });

  describe("with fallback chains", () => {
    it("serves the fallback-locale doc when requesting its slug and no own translation", () => {
      const all = indexOf({
        en: [doc("en", "hello")],
        "pt-BR": [doc("pt-BR", "ola-br", "hello")],
      });
      // Request pt with chain [pt-BR], using the pt-BR slug, no pt translation.
      const r = resolveLocalizedDocument("ola-br", "pt", "en", all, routable, undefined, ["pt-BR"]);
      assert.equal(r.document?.slug, "ola-br");
      assert.equal(r.actualLocale, "pt-BR");
    });

    it("redirects an EN-slug request to the fallback-locale slug under the pt URL", () => {
      const all = indexOf({
        en: [doc("en", "hello")],
        "pt-BR": [doc("pt-BR", "ola-br", "hello")],
      });
      const r = resolveLocalizedDocument("hello", "pt", "en", all, routable, undefined, ["pt-BR"]);
      assert.equal(r.document, null);
      assert.equal(r.shouldRedirectTo, "/pt/blog/ola-br");
    });

    it("redirects the fallback-locale slug to the pt slug when pt has its own translation", () => {
      const all = indexOf({
        en: [doc("en", "hello")],
        pt: [doc("pt", "ola-pt", "hello")],
        "pt-BR": [doc("pt-BR", "ola-br", "hello")],
      });
      const r = resolveLocalizedDocument("ola-br", "pt", "en", all, routable, undefined, ["pt-BR"]);
      assert.equal(r.document, null);
      assert.equal(r.shouldRedirectTo, "/pt/blog/ola-pt");
    });

    it("respects chain order (serves pt-PT before pt-BR)", () => {
      const all = indexOf({
        en: [doc("en", "hello")],
        "pt-PT": [doc("pt-PT", "ola-pt", "hello")],
        "pt-BR": [doc("pt-BR", "ola-br", "hello")],
      });
      const r = resolveLocalizedDocument("ola-pt", "pt", "en", all, routable, undefined, [
        "pt-PT",
        "pt-BR",
      ]);
      assert.equal(r.document?.slug, "ola-pt");
      assert.equal(r.actualLocale, "pt-PT");
    });

    it("falls back to EN when nothing in the chain is translated", () => {
      const all = indexOf({ en: [doc("en", "hello")] });
      const r = resolveLocalizedDocument("hello", "pt", "en", all, routable, undefined, ["pt-BR"]);
      assert.equal(r.document?.slug, "hello");
      assert.equal(r.actualLocale, "en");
    });

    it("returns null without a redirect for non-routable types", () => {
      const all = indexOf({
        en: [doc("en", "hello")],
        "pt-BR": [doc("pt-BR", "ola-br", "hello")],
      });
      const r = resolveLocalizedDocument("hello", "pt", "en", all, nonRoutable, undefined, [
        "pt-BR",
      ]);
      assert.equal(r.document, null);
      assert.equal(r.shouldRedirectTo, undefined);
    });
  });
});
