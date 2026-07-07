import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  backRefsFor,
  buildAssetRefIndex,
  buildBackRefIndex,
} from "./introspect-fields.js";

describe("buildBackRefIndex body scanning", () => {
  it("registers ${{relation:...}} body tokens as back-refs with a body label", () => {
    const index = buildBackRefIndex([
      {
        typeId: "post",
        enSlug: "hello",
        frontmatter: {},
        relationFields: [],
        body: 'x ${{relation:author:jane}} y ${{relation:author:jane:slug}} z',
      },
    ]);
    const refs = backRefsFor(index, "author", "jane");
    // Two tokens (url + slug mode) both point at author/jane.
    assert.equal(refs.length, 2);
    assert.ok(refs.every((r) => r.typeId === "post" && r.enSlug === "hello" && r.field === "body"));
  });

  it("combines frontmatter relation fields and body tokens", () => {
    const index = buildBackRefIndex([
      {
        typeId: "post",
        enSlug: "p",
        frontmatter: { author: "jane" },
        relationFields: [
          { path: ["author"], kind: "relation", relationTarget: "author" },
        ],
        body: "body ${{relation:tag:news}}",
      },
    ]);
    assert.equal(backRefsFor(index, "author", "jane").length, 1);
    assert.equal(backRefsFor(index, "tag", "news").length, 1);
  });
});

describe("buildAssetRefIndex body scanning", () => {
  it("registers ${{asset:...}} body tokens as DECLARED references", () => {
    const index = buildAssetRefIndex([
      {
        typeId: "post",
        enSlug: "p",
        frontmatter: {},
        body: "hero ${{asset:/img/hero.webp}}",
        assetFields: [],
      },
    ]);
    const refs = index.get("/img/hero.webp");
    assert.ok(refs && refs.length === 1);
    assert.equal(refs![0]!.declared, true);
    assert.equal(refs![0]!.field, "body");
  });

  it("does not double-count an asset token via the heuristic pass", () => {
    const index = buildAssetRefIndex([
      {
        typeId: "post",
        enSlug: "p",
        frontmatter: {},
        body: '![alt](/img/hero.webp) and ${{asset:/img/hero.webp}}',
        assetFields: [],
      },
    ]);
    const refs = index.get("/img/hero.webp");
    // The token registers it as declared; the markdown image is skipped as a dup.
    assert.equal(refs!.length, 1);
    assert.equal(refs![0]!.declared, true);
  });
});
