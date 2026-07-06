import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseGeminiResponse } from "./gemini-client.js";

describe("parseGeminiResponse", () => {
  it("parses a full frontmatter + body payload", () => {
    const parsed = parseGeminiResponse(
      JSON.stringify({ frontmatter: { title: "Bonjour" }, body: "Corps.", slug: "bonjour" }),
    );
    assert.deepEqual(parsed.frontmatter, { title: "Bonjour" });
    assert.equal(parsed.body, "Corps.");
    assert.equal(parsed.slug, "bonjour");
  });

  it("defaults frontmatter to {} for body-only responses", () => {
    // Types without translatable frontmatter use a body-only response schema
    // (see buildGeminiResponseSchema); downstream validation expects an object.
    const parsed = parseGeminiResponse(JSON.stringify({ body: "## Corrigé\n\n- point" }));
    assert.deepEqual(parsed.frontmatter, {});
    assert.equal(parsed.body, "## Corrigé\n\n- point");
  });

  it("still unwraps a fenced payload before defaulting", () => {
    const parsed = parseGeminiResponse('```json\n{"body": "Corps."}\n```');
    assert.deepEqual(parsed.frontmatter, {});
    assert.equal(parsed.body, "Corps.");
  });
});
