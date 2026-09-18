import { test } from "node:test";
import assert from "node:assert/strict";
import { createCrossLocaleRescue, type AlternatesMap } from "./cross-locale-rescue.js";

const CONFIG = { locales: ["en", "fr", "da", "es"], defaultLocale: "en" };

const postCluster = {
  en: "/blog/my-post",
  fr: "/fr/blog/mon-article",
  es: "/es/blog/mi-articulo",
  "x-default": "/blog/my-post",
};
const guideCluster = {
  en: "/shopify/vs/antla",
  fr: "/fr/shopify/vs/antla",
  "x-default": "/shopify/vs/antla",
};

function buildAlternates(): AlternatesMap {
  const map: AlternatesMap = {};
  for (const cluster of [postCluster, guideCluster]) {
    for (const pathname of Object.values(cluster)) map[pathname] = cluster;
  }
  return map;
}

test("rescues a localized slug under the wrong locale prefix", () => {
  const rescue = createCrossLocaleRescue(buildAlternates(), CONFIG);
  assert.equal(rescue.resolve("/da/blog/mi-articulo"), "/blog/my-post"); // no da variant → default
  assert.equal(rescue.resolve("/fr/blog/mi-articulo"), "/fr/blog/mon-article");
  assert.equal(rescue.resolve("/blog/mon-article"), "/blog/my-post"); // foreign slug on default-locale path
  assert.equal(rescue.resolve("/es/blog/my-post"), "/es/blog/mi-articulo"); // default slug under locale
});

test("multi-segment prefixes are matched as part of the key", () => {
  const rescue = createCrossLocaleRescue(buildAlternates(), CONFIG);
  assert.equal(rescue.resolve("/es/shopify/vs/antla"), "/shopify/vs/antla"); // no es variant → default
  assert.equal(rescue.resolve("/glossary/mon-article"), null); // same slug, different prefix
});

test("never rescues real pages, unknown slugs, or bare prefixes", () => {
  const rescue = createCrossLocaleRescue(buildAlternates(), CONFIG);
  assert.equal(rescue.resolve("/fr/blog/mon-article"), null); // exact live page
  assert.equal(rescue.resolve("/blog/my-post"), null);
  assert.equal(rescue.resolve("/da/blog/unknown-slug"), null);
  assert.equal(rescue.resolve("/fr"), null);
  assert.equal(rescue.resolve("/blog"), null);
});

test("ambiguous slugs shared by two documents are dropped", () => {
  const a = { en: "/blog/dup", fr: "/fr/blog/twin", "x-default": "/blog/dup" };
  const b = { en: "/blog/other", es: "/es/blog/twin", "x-default": "/blog/other" };
  const map: AlternatesMap = {};
  for (const cluster of [a, b]) for (const p of Object.values(cluster)) map[p] = cluster;
  const rescue = createCrossLocaleRescue(map, CONFIG);
  assert.equal(rescue.resolve("/da/blog/twin"), null);
});

test("retired slugs rescue through the redirect map, hopped to the requested locale", () => {
  const redirects = {
    "/es/blog/viejo-articulo": "/es/blog/mi-articulo",
    "/blog/old-post": "/blog/my-post",
  };
  const rescue = createCrossLocaleRescue(buildAlternates(), { ...CONFIG, redirects });
  // retired ES slug under FR prefix → FR variant of the redirect destination
  assert.equal(rescue.resolve("/fr/blog/viejo-articulo"), "/fr/blog/mon-article");
  // retired ES slug under a locale with no variant → default
  assert.equal(rescue.resolve("/da/blog/viejo-articulo"), "/blog/my-post");
  // exact redirect source is left to the caller's redirect map
  assert.equal(rescue.resolve("/es/blog/viejo-articulo"), null);
  // retired EN slug under a locale prefix
  assert.equal(rescue.resolve("/fr/blog/old-post"), "/fr/blog/mon-article");
});

test("one retired slug under several locale prefixes with per-locale destinations is not ambiguous", () => {
  // Generators emit the same EN slug under each untranslated locale prefix,
  // each pointing at that locale's destination.
  const redirects = {
    "/blog/old-post": "/blog/my-post",
    "/da/blog/old-post": "/blog/my-post",
    "/fr/blog/old-post": "/fr/blog/mon-article",
  };
  const rescue = createCrossLocaleRescue(buildAlternates(), { ...CONFIG, redirects });
  // requested under a locale with NO redirect source for this slug → default
  // locale's destination, hopped to the requested locale's variant
  assert.equal(rescue.resolve("/es/blog/old-post"), "/es/blog/mi-articulo");
});

test("redirect destination outside the alternates map is returned as-is", () => {
  const redirects = { "/blog/moved": "/changelog/moved" };
  const rescue = createCrossLocaleRescue(buildAlternates(), { ...CONFIG, redirects });
  assert.equal(rescue.resolve("/fr/blog/moved"), "/changelog/moved");
});
