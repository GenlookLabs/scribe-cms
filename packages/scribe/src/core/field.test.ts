import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import { field, getFieldKind, getRelationTarget } from "./field.js";
import { introspectSchema, listRelationFields } from "./introspect-schema.js";

describe("field.relation metadata durability", () => {
  it("plain single relation carries metadata", () => {
    const meta = getRelationTarget(field.relation("author"));
    assert.deepEqual(meta, { typeId: "author", multiple: false, optional: false });
  });

  it("optional single relation keeps metadata through the ZodOptional wrapper", () => {
    const schema = field.relation("blog", { optional: true });
    const meta = getRelationTarget(schema);
    assert.deepEqual(meta, { typeId: "blog", multiple: false, optional: true });
    assert.equal(schema.safeParse(undefined).success, true);
    assert.equal(schema.safeParse("some-slug").success, true);
    assert.equal(schema.safeParse("").success, false);
  });

  it("multiple relation with min/max/optional keeps metadata (the old chained form lost it)", () => {
    const schema = field.relation("glossary", { multiple: true, max: 8, optional: true });
    const meta = getRelationTarget(schema);
    assert.deepEqual(meta, { typeId: "glossary", multiple: true, optional: true });
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
    });
    assert.deepEqual(byPath.get("relatedTerms"), {
      path: ["relatedTerms"],
      kind: "relation",
      relationTarget: "glossary",
      relationMultiple: true,
      relationOptional: true,
    });
    assert.equal(byPath.get("nested.glossarySlug")?.relationTarget, "glossary");
  });

  it("keeps translatable/structural kinds for non-relation fields", () => {
    const kinds = new Map(introspectSchema(schema).map((f) => [f.path.join("."), f.kind]));
    assert.equal(kinds.get("title"), "translatable");
  });
});
