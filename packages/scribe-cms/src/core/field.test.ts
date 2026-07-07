import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import { field, getAssetMeta, getFieldKind, getRelationTarget } from "./field.js";
import { introspectSchema, listAssetFields, listRelationFields } from "./introspect-schema.js";

describe("field.relation metadata durability", () => {
  it("plain single relation carries metadata", () => {
    const meta = getRelationTarget(field.relation("author"));
    assert.deepEqual(meta, {
      typeId: "author",
      multiple: false,
      optional: false,
      onTargetDelete: "restrict",
    });
  });

  it("optional single relation keeps metadata through the ZodOptional wrapper", () => {
    const schema = field.relation("blog", { optional: true });
    const meta = getRelationTarget(schema);
    assert.deepEqual(meta, {
      typeId: "blog",
      multiple: false,
      optional: true,
      onTargetDelete: "restrict",
    });
    assert.equal(schema.safeParse(undefined).success, true);
    assert.equal(schema.safeParse("some-slug").success, true);
    assert.equal(schema.safeParse("").success, false);
  });

  it("multiple relation with min/max/optional keeps metadata (the old chained form lost it)", () => {
    const schema = field.relation("glossary", { multiple: true, max: 8, optional: true });
    const meta = getRelationTarget(schema);
    assert.deepEqual(meta, {
      typeId: "glossary",
      multiple: true,
      optional: true,
      onTargetDelete: "restrict",
    });
    assert.equal(schema.safeParse(["a", "b"]).success, true);
    assert.equal(schema.safeParse(Array.from({ length: 9 }, (_, i) => `s${i}`)).success, false);
    assert.equal(schema.safeParse(undefined).success, true);
  });

  it("relation fields are structural (never translated)", () => {
    assert.equal(getFieldKind(field.relation("author")), "structural");
  });

  it("min/max without multiple throws at definition time", () => {
    assert.throws(() => field.relation("glossary", { max: 8 }), /multiple: true/);
  });
});

describe("introspectSchema relation discovery", () => {
  const schema = z.object({
    title: field.translatable(z.string()),
    author: field.relation("author"),
    relatedTerms: field.relation("glossary", { multiple: true, max: 8, optional: true }),
    nested: field.structural(
      z.object({ glossarySlug: field.relation("glossary", { optional: true }) }).optional(),
    ),
  });

  it("finds top-level and nested relation fields with full metadata", () => {
    const relations = listRelationFields(schema);
    const byPath = new Map(relations.map((r) => [r.path.join("."), r]));

    assert.deepEqual(byPath.get("author"), {
      path: ["author"],
      kind: "relation",
      relationTarget: "author",
      relationMultiple: false,
      relationOptional: false,
      relationOnTargetDelete: "restrict",
    });
    assert.deepEqual(byPath.get("relatedTerms"), {
      path: ["relatedTerms"],
      kind: "relation",
      relationTarget: "glossary",
      relationMultiple: true,
      relationOptional: true,
      relationOnTargetDelete: "restrict",
    });
    assert.equal(byPath.get("nested.glossarySlug")?.relationTarget, "glossary");
  });

  it("keeps translatable/structural kinds for non-relation fields", () => {
    const kinds = new Map(introspectSchema(schema).map((f) => [f.path.join("."), f.kind]));
    assert.equal(kinds.get("title"), "translatable");
  });
});

describe("field.asset metadata durability", () => {
  it("plain asset carries defaults (optional false, no dir/template)", () => {
    assert.deepEqual(getAssetMeta(field.asset()), {
      dir: undefined,
      template: undefined,
      formats: undefined,
      maxKB: undefined,
      optional: false,
      onDelete: "delete",
    });
  });

  it("carries all constraints through options", () => {
    const meta = getAssetMeta(
      field.asset({ dir: "/try-on/garments", formats: ["webp"], maxKB: 150 }),
    );
    assert.deepEqual(meta, {
      dir: "/try-on/garments",
      template: undefined,
      formats: ["webp"],
      maxKB: 150,
      optional: false,
      onDelete: "delete",
    });
  });

  it("optional asset keeps metadata through the ZodOptional wrapper and parses undefined", () => {
    const schema = field.asset({ optional: true });
    assert.equal(getAssetMeta(schema)?.optional, true);
    assert.equal(schema.safeParse(undefined).success, true);
    assert.equal(schema.safeParse("/a.webp").success, true);
    assert.equal(schema.safeParse("").success, false);
  });

  it("templated asset may be omitted in frontmatter (wrapped optional)", () => {
    const schema = field.asset({ template: "/try-on/garments/{slug}/product.webp" });
    assert.equal(getAssetMeta(schema)?.template, "/try-on/garments/{slug}/product.webp");
    assert.equal(schema.safeParse(undefined).success, true);
    assert.equal(schema.safeParse("/explicit.webp").success, true);
  });

  it("required asset rejects undefined", () => {
    assert.equal(field.asset().safeParse(undefined).success, false);
  });

  it("asset fields are structural (never translated)", () => {
    assert.equal(getFieldKind(field.asset()), "structural");
  });

  it("getAssetMeta returns null for non-asset fields", () => {
    assert.equal(getAssetMeta(field.translatable(z.string())), null);
    assert.equal(getAssetMeta(field.relation("author")), null);
    assert.equal(getAssetMeta(z.string()), null);
  });
});

describe("introspectSchema asset discovery", () => {
  const schema = z.object({
    title: field.translatable(z.string()),
    productImage: field.asset({ dir: "/try-on/garments", formats: ["webp"], maxKB: 150 }),
    gallery: z.array(z.object({ src: field.asset({ template: "/g/{slug}.webp" }) })),
    nested: field
      .structural(z.object({ hero: field.asset({ optional: true }) }).optional()),
  });

  it("finds top-level, nested-in-object, and array asset fields with full meta", () => {
    const assets = listAssetFields(schema);
    const byPath = new Map(assets.map((a) => [a.path.join("."), a]));

    assert.deepEqual(byPath.get("productImage"), {
      path: ["productImage"],
      kind: "asset",
      assetDir: "/try-on/garments",
      assetTemplate: undefined,
      assetFormats: ["webp"],
      assetMaxKB: 150,
      assetOptional: false,
      assetOnDelete: "delete",
    });
    assert.equal(byPath.get("gallery.*.src")?.assetTemplate, "/g/{slug}.webp");
    assert.equal(byPath.get("nested.hero")?.assetOptional, true);
  });
});
