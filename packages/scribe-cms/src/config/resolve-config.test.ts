import assert from "node:assert/strict";
import { describe, it } from "node:test";
import path from "node:path";
import { z } from "zod";
import { resolveConfig, isResolvedConfig } from "./resolve-config.js";
import type { ScribeConfigInput } from "../core/types.js";

const base: ScribeConfigInput = {
  rootDir: "/proj",
  locales: ["en", "fr"],
  types: [
    { id: "blog", schema: z.object({}), path: "/blog/{slug}" },
    { id: "author", schema: z.object({}), contentDir: "authors" },
  ],
};

describe("resolveConfig", () => {
  it("applies defaults and resolves paths", () => {
    const config = resolveConfig(base);
    assert.equal(config.rootDir, path.resolve("/proj/content"));
    assert.equal(config.storePath, path.resolve("/proj/.scribe/store.sqlite"));
    assert.equal(config.defaultLocale, "en");

    const blog = config.types[0]!;
    assert.equal(blog.contentDir, "blog");
    assert.equal(blog.label, "Blog");
    assert.equal(blog.slugStrategy, "fixed");
    assert.equal(blog.indexFallback, "en"); // routable → en fallback

    const author = config.types[1]!;
    assert.equal(author.contentDir, "authors");
    assert.equal(author.indexFallback, "none"); // reference-only → none
  });

  it("is idempotent", () => {
    const config = resolveConfig(base);
    assert.equal(isResolvedConfig(config), true);
    assert.equal(resolveConfig(config), config);
  });

  it("rejects defaultLocale not present in locales", () => {
    assert.throws(
      () => resolveConfig({ ...base, defaultLocale: "de" }),
      /defaultLocale "de" is not in locales/,
    );
  });

  it("rejects duplicate type ids", () => {
    assert.throws(
      () => resolveConfig({ ...base, types: [...base.types, base.types[0]!] }),
      /duplicate content type id "blog"/,
    );
  });

  it("rejects invalid path templates", () => {
    assert.throws(
      () =>
        resolveConfig({
          ...base,
          types: [{ id: "x", schema: z.object({}), path: "/x/no-slug" }],
        }),
      /exactly one \{slug\}/,
    );
  });

  describe("localeFallbacks", () => {
    it("derives chains from locale tags when omitted (default enabled)", () => {
      const config = resolveConfig({
        ...base,
        locales: ["en", "pt", "pt-BR"],
      });
      assert.deepEqual(config.localeFallbacks, { "pt-BR": ["pt"] });
    });

    it("derives a region → language chain", () => {
      const config = resolveConfig({
        ...base,
        locales: ["en", "fr", "fr-CA"],
      });
      assert.deepEqual(config.localeFallbacks, { "fr-CA": ["fr"] });
    });

    it("orders multi-subtag chains longest prefix first", () => {
      const config = resolveConfig({
        ...base,
        locales: ["en", "zh", "zh-Hant", "zh-Hant-TW"],
      });
      assert.deepEqual(config.localeFallbacks, {
        "zh-Hant-TW": ["zh-Hant", "zh"],
        "zh-Hant": ["zh"],
      });
    });

    it("excludes the defaultLocale from chains (it stays the implicit final fallback)", () => {
      const config = resolveConfig({
        ...base,
        locales: ["en", "en-GB"],
      });
      assert.deepEqual(config.localeFallbacks, {});
    });

    it("matches prefixes case-insensitively but stores the configured spelling", () => {
      const config = resolveConfig({
        ...base,
        locales: ["en", "PT", "pt-br"],
      });
      assert.deepEqual(config.localeFallbacks, { "pt-br": ["PT"] });
    });

    it("skips prefixes that are not configured locales", () => {
      const config = resolveConfig({
        ...base,
        locales: ["en", "zh", "zh-Hant-TW"],
      });
      assert.deepEqual(config.localeFallbacks, { "zh-Hant-TW": ["zh"] });
    });

    it("resolves to an empty object when disabled", () => {
      const config = resolveConfig({
        ...base,
        locales: ["en", "pt", "pt-BR"],
        localeFallbacks: false,
      });
      assert.deepEqual(config.localeFallbacks, {});
    });
  });
});
