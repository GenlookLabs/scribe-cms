import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import {
  field,
  getAssetMeta,
  getFieldDescription,
  getFieldKind,
  getRelationTarget,
} from "./field.js";
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
      multiple: false,
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
      multiple: false,
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

describe("field descriptions via Zod .describe()", () => {
  it("reads a description on a bare schema", () => {
    assert.equal(getFieldDescription(z.string().describe("a title")), "a title");
  });

  it("reads a description on the inner schema through the optional wrapper", () => {
    // describe() sits on the inner string; optional() wraps it afterwards.
    const schema = z.string().describe("inner help").optional();
    assert.equal(getFieldDescription(schema), "inner help");
  });

  it("reads a description on the outer optional wrapper", () => {
    const schema = z.string().optional().describe("outer help");
    assert.equal(getFieldDescription(schema), "outer help");
  });

  it("outer wins when both wrapper levels carry a description", () => {
    const schema = z.string().describe("inner").optional().describe("outer");
    assert.equal(getFieldDescription(schema), "outer");
  });

  it("returns undefined when no description is set", () => {
    assert.equal(getFieldDescription(z.string()), undefined);
    assert.equal(getFieldDescription(z.string().optional()), undefined);
  });

  it(".describe() does NOT break relation/asset/kind brand detection (clone keeps _def brand)", () => {
    // .describe() returns a clone that drops instance symbols but shares _def,
    // where the brand is also stored — so detection must still succeed.
    const rel = field.relation("author").describe("who wrote it");
    assert.equal(getRelationTarget(rel)?.typeId, "author");
    assert.equal(getFieldDescription(rel), "who wrote it");

    const relMulti = field.relation("glossary", { multiple: true }).describe("terms");
    assert.equal(getRelationTarget(relMulti)?.multiple, true);

    const asset = field.asset({ dir: "/g" }).describe("the hero image");
    assert.equal(getAssetMeta(asset)?.dir, "/g");
    assert.equal(getFieldDescription(asset), "the hero image");

    const assetMulti = field.asset({ dir: "/g", multiple: true }).describe("images");
    assert.equal(getAssetMeta(assetMulti)?.multiple, true);

    assert.equal(getFieldKind(field.translatable(z.string()).describe("x")), "translatable");
  });

  it("introspectSchema surfaces description on leaf field metas", () => {
    const schema = z.object({
      title: field.translatable(z.string()).describe("shown as the H1"),
      hero: field.asset({ dir: "/g" }).describe("card image"),
      plain: z.string(),
    });
    const byPath = new Map(introspectSchema(schema).map((f) => [f.path.join("."), f]));
    assert.equal(byPath.get("title")?.description, "shown as the H1");
    assert.equal(byPath.get("hero")?.description, "card image");
    // No description key at all when none was set (keeps deepEqual shapes stable).
    assert.equal("description" in (byPath.get("plain") as object), false);
  });
});

describe("field.asset multiple", () => {
  it("carries multiple/min/max metadata and parses an array of paths", () => {
    const schema = field.asset({ dir: "/g", multiple: true, min: 1, max: 3 });
    assert.deepEqual(getAssetMeta(schema), {
      dir: "/g",
      template: undefined,
      formats: undefined,
      maxKB: undefined,
      optional: false,
      onDelete: "delete",
      multiple: true,
      min: 1,
      max: 3,
    });
    assert.equal(schema.safeParse(["/g/a.webp"]).success, true);
    assert.equal(schema.safeParse(["/g/a.webp", "/g/b.webp", "/g/c.webp"]).success, true);
    assert.equal(schema.safeParse([]).success, false); // below min
    assert.equal(schema.safeParse(["/a", "/b", "/c", "/d"]).success, false); // above max
    assert.equal(schema.safeParse("/g/a.webp").success, false); // not an array
  });

  it("optional multiple parses undefined", () => {
    const schema = field.asset({ multiple: true, optional: true });
    assert.equal(schema.safeParse(undefined).success, true);
    assert.equal(schema.safeParse(["/a.webp"]).success, true);
  });

  it("throws when combining template with multiple", () => {
    assert.throws(
      () => field.asset({ multiple: true, template: "/g/{slug}.webp" }),
      /cannot be combined with a template/,
    );
  });

  it("throws when min/max are used without multiple", () => {
    assert.throws(() => field.asset({ min: 1 }), /min\/max require \{ multiple: true \}/);
  });

  it("introspectSchema emits assetMultiple only for multiple fields", () => {
    const schema = z.object({
      single: field.asset({ dir: "/g" }),
      images: field.asset({ dir: "/g", multiple: true, min: 2 }),
    });
    const byPath = new Map(listAssetFields(schema).map((a) => [a.path.join("."), a]));
    assert.equal(byPath.get("single")?.assetMultiple, undefined);
    assert.equal(byPath.get("images")?.assetMultiple, true);
    assert.equal(byPath.get("images")?.assetMin, 2);
  });
});
