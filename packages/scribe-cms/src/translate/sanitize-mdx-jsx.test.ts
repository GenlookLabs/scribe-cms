import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sanitizeMdxJsxAttributeQuotes } from "./sanitize-mdx-jsx.js";

describe("sanitizeMdxJsxAttributeQuotes", () => {
  it("rewrites FaqItem question with Hebrew gereshayim", () => {
    const input = `<Faq>
  <FaqItem question="אילו תהליכי דוא"ל כדאי לי להגדיר עבור מדידה וירטואלית?">
    Answer text.
  </FaqItem>
</Faq>`;
    const { body, adjusted } = sanitizeMdxJsxAttributeQuotes(input);
    assert.equal(adjusted, true);
    assert.match(body, /<FaqItem question='אילו תהליכי דוא"ל כדאי לי להגדיר עבור מדידה וירטואלית\?'/);
    assert.doesNotMatch(body, /question="אילו/);
  });

  it("leaves valid double-quoted attributes unchanged", () => {
    const input = `<FaqItem question="What email flows should I set up?">
    We recommend a flow.
  </FaqItem>`;
    const { body, adjusted } = sanitizeMdxJsxAttributeQuotes(input);
    assert.equal(adjusted, false);
    assert.equal(body, input);
  });

  it("leaves iframe src URLs with query strings unchanged", () => {
    const input =
      '<iframe src="https://www.linkedin.com/embed/feed/update/urn:li:ugcPost:123?collapsed=1" height="450" width="504"></iframe>';
    const { body, adjusted } = sanitizeMdxJsxAttributeQuotes(input);
    assert.equal(adjusted, false);
    assert.equal(body, input);
  });
});
