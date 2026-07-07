import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractInlineTokens } from "../src/inline/tokens.js";
import { buildPreviewTokens } from "./preview-tokens.js";

describe("buildPreviewTokens", () => {
  it("maps static tokens to their text value", () => {
    const { tokens } = extractInlineTokens('x ${{static:"hello"}} y');
    const pv = buildPreviewTokens(tokens, { enFrontmatter: {}, docExists: () => true });
    assert.equal(pv.length, 1);
    assert.equal(pv[0]!.kind, "static");
    assert.equal(pv[0]!.value, "hello");
  });

  it("maps var tokens from enFrontmatter.vars", () => {
    const { tokens } = extractInlineTokens("x ${{var:cta}} y");
    const pv = buildPreviewTokens(tokens, {
      enFrontmatter: { vars: { cta: "Shop now" } },
      docExists: () => true,
    });
    assert.equal(pv[0]!.kind, "var");
    assert.equal(pv[0]!.value, "Shop now");
  });

  it("maps missing var tokens to an empty value", () => {
    const { tokens } = extractInlineTokens("x ${{var:missing}} y");
    const pv = buildPreviewTokens(tokens, { enFrontmatter: {}, docExists: () => true });
    assert.equal(pv[0]!.value, "");
  });

  it("maps asset tokens to their web path", () => {
    const { tokens } = extractInlineTokens("x ${{asset:/img/x.webp}} y");
    const pv = buildPreviewTokens(tokens, { enFrontmatter: {}, docExists: () => true });
    assert.equal(pv[0]!.kind, "asset");
    assert.equal(pv[0]!.value, "/img/x.webp");
  });

  it("maps relation tokens with studioUrl and label when the target exists", () => {
    const { tokens } = extractInlineTokens("x ${{relation:glossary:foo:href}} y");
    const pv = buildPreviewTokens(tokens, { enFrontmatter: {}, docExists: () => true });
    assert.equal(pv[0]!.kind, "relation");
    assert.equal(pv[0]!.studioUrl, "/type/glossary/doc/foo");
    assert.equal(pv[0]!.label, "foo");
    assert.equal(pv[0]!.dangling, false);
  });

  it("marks relation tokens as dangling when docExists returns false", () => {
    const { tokens } = extractInlineTokens("x ${{relation:glossary:foo:href}} y");
    const pv = buildPreviewTokens(tokens, { enFrontmatter: {}, docExists: () => false });
    assert.equal(pv[0]!.dangling, true);
  });
});
