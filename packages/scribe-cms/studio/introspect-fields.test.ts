import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import { field } from "../src/core/field.js";
import {
  listAssetFields,
  listRelationFields,
} from "../src/core/introspect-schema.js";
import {
  backRefsFor,
  buildAssetRefIndex,
  buildBackRefIndex,
  filterFieldsFor,
  introspectStudioFields,
  keyFieldsFor,
} from "./introspect-fields.js";

const exampleSchema = z.object({
  garment: field.relation("garment"),
  model: field.relation("model"),
  resultImage: field.asset({ dir: "/try-on", formats: ["webp"], maxKB: 200 }),
  status: field.structural(z.enum(["real", "placeholder", "needs-regen"])),
  featured: field.structural(z.boolean().optional()),
  note: field.translatable(z.string().optional()),
});

const modelSchema = z.object({
  displayName: field.structural(z.string()),
  gender: field.structural(z.enum(["female", "male"])),
  photo: field.asset({ dir: "/try-on", formats: ["webp"] }),
});

describe("introspectStudioFields", () => {
  it("extracts enum options and boolean/scalar flags", () => {
    const fields = introspectStudioFields(exampleSchema);
    const status = fields.find((f) => f.path.join(".") === "status");
    assert.deepEqual(status?.enumOptions, ["real", "placeholder", "needs-regen"]);
    const featured = fields.find((f) => f.path.join(".") === "featured");
    assert.equal(featured?.isBoolean, true);
    const note = fields.find((f) => f.path.join(".") === "note");
    assert.equal(note?.kind, "translatable");
  });
});

describe("filterFieldsFor", () => {
  it("maps enum → enum, relation → relation, boolean → boolean", () => {
    const filters = filterFieldsFor(exampleSchema);
    const byKey = new Map(filters.map((f) => [f.key, f]));
    assert.equal(byKey.get("status")?.kind, "enum");
    assert.deepEqual(byKey.get("status")?.enumOptions, ["real", "placeholder", "needs-regen"]);
    assert.equal(byKey.get("garment")?.kind, "relation");
    assert.equal(byKey.get("garment")?.relationTarget, "garment");
    assert.equal(byKey.get("featured")?.kind, "boolean");
    // asset fields are never filters
    assert.equal(byKey.has("resultImage"), false);
  });
});

describe("keyFieldsFor", () => {
  it("excludes asset fields and caps the count", () => {
    const keys = keyFieldsFor(exampleSchema, 3).map((f) => f.path.join("."));
    assert.equal(keys.length, 3);
    assert.equal(keys.includes("resultImage"), false);
  });
});

describe("buildBackRefIndex", () => {
  const relationFields = listRelationFields(exampleSchema);
  const inputs = [
    {
      typeId: "example",
      enSlug: "ex-1",
      frontmatter: { garment: "denim", model: "brooke", status: "real" },
      relationFields,
    },
    {
      typeId: "example",
      enSlug: "ex-2",
      frontmatter: { garment: "denim", model: "kai", status: "placeholder" },
      relationFields,
    },
  ];

  it("indexes which entries reference a target by relation", () => {
    const index = buildBackRefIndex(inputs);
    const denimRefs = backRefsFor(index, "garment", "denim");
    assert.equal(denimRefs.length, 2);
    assert.deepEqual(
      denimRefs.map((r) => r.enSlug).sort(),
      ["ex-1", "ex-2"],
    );
    assert.equal(denimRefs[0]!.field, "garment");

    const brookeRefs = backRefsFor(index, "model", "brooke");
    assert.equal(brookeRefs.length, 1);
    assert.equal(brookeRefs[0]!.enSlug, "ex-1");
  });

  it("returns empty for an unreferenced target", () => {
    const index = buildBackRefIndex(inputs);
    assert.deepEqual(backRefsFor(index, "model", "nobody"), []);
  });

  it("handles multiple (array) relations", () => {
    const schema = z.object({
      related: field.relation("glossary", { multiple: true, optional: true }),
    });
    const rf = listRelationFields(schema);
    const index = buildBackRefIndex([
      { typeId: "glossary", enSlug: "term-a", frontmatter: { related: ["b", "c"] }, relationFields: rf },
    ]);
    assert.equal(backRefsFor(index, "glossary", "b").length, 1);
    assert.equal(backRefsFor(index, "glossary", "c").length, 1);
  });
});

describe("buildAssetRefIndex", () => {
  it("indexes declared asset field values with constraint metadata", () => {
    const assetFields = listAssetFields(exampleSchema);
    const index = buildAssetRefIndex([
      {
        typeId: "example",
        enSlug: "ex-1",
        frontmatter: { resultImage: "/try-on/ex-1.webp" },
        body: "",
        assetFields,
      },
    ]);
    const refs = index.get("/try-on/ex-1.webp");
    assert.ok(refs);
    assert.equal(refs!.length, 1);
    assert.equal(refs![0]!.declared, true);
    assert.equal(refs![0]!.field, "resultImage");
    assert.equal(refs![0]!.maxKB, 200);
    assert.deepEqual(refs![0]!.formats, ["webp"]);
  });

  it("collects heuristic body image references (non-declared)", () => {
    const assetFields = listAssetFields(modelSchema);
    const index = buildAssetRefIndex([
      {
        typeId: "blog",
        enSlug: "post",
        frontmatter: {},
        body: "Here is an image ![alt](/blog-images/hero.webp) inline.",
        assetFields,
      },
    ]);
    const refs = index.get("/blog-images/hero.webp");
    assert.ok(refs);
    assert.equal(refs![0]!.declared, false);
  });

  it("does not double-count a declared value also matched heuristically", () => {
    const assetFields = listAssetFields(modelSchema);
    const index = buildAssetRefIndex([
      {
        typeId: "model",
        enSlug: "brooke",
        frontmatter: { photo: "/try-on/brooke.webp" },
        body: "",
        assetFields,
      },
    ]);
    const refs = index.get("/try-on/brooke.webp");
    assert.equal(refs!.length, 1);
    assert.equal(refs![0]!.declared, true);
  });

  it("materializes templated asset paths", () => {
    const schema = z.object({
      hero: field.asset({ template: "/try-on/{slug}/product.webp" }),
    });
    const assetFields = listAssetFields(schema);
    const index = buildAssetRefIndex([
      { typeId: "garment", enSlug: "denim", frontmatter: {}, body: "", assetFields },
    ]);
    assert.ok(index.get("/try-on/denim/product.webp"));
  });
});
