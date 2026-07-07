import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderMdxApprox } from "./mdx-preview.js";

describe("renderMdxApprox", () => {
  it("renders ATX headings", () => {
    const html = renderMdxApprox("# Title\n\n## Sub");
    assert.match(html, /<h1 class="mdx-h">Title<\/h1>/);
    assert.match(html, /<h2 class="mdx-h">Sub<\/h2>/);
  });

  it("renders bold and inline code", () => {
    const html = renderMdxApprox("This is **bold** and `code`.");
    assert.match(html, /<strong>bold<\/strong>/);
    assert.match(html, /<code class="mdx-inline-code">code<\/code>/);
  });

  it("does not treat markdown markers inside inline code as formatting", () => {
    const html = renderMdxApprox("Use `a **b** c` here.");
    assert.match(html, /<code class="mdx-inline-code">a \*\*b\*\* c<\/code>/);
    assert.doesNotMatch(html, /<strong>b<\/strong>/);
  });

  it("renders italic without breaking snake_case words", () => {
    const html = renderMdxApprox("An *emphasised* value_with_underscores stays intact.");
    assert.match(html, /<em>emphasised<\/em>/);
    assert.match(html, /value_with_underscores/);
  });

  it("renders links as styled spans, never real anchors", () => {
    const html = renderMdxApprox("See [the docs](/docs/getting-started).");
    assert.match(html, /<span class="mdx-link" title="\/docs\/getting-started">the docs<\/span>/);
    assert.doesNotMatch(html, /<a /);
  });

  it("renders a GFM pipe table", () => {
    const md = "| Name | Age |\n| --- | --- |\n| Ann | 30 |\n| Bo | 25 |";
    const html = renderMdxApprox(md);
    assert.match(html, /<table class="mdx-table">/);
    assert.match(html, /<th>Name<\/th>/);
    assert.match(html, /<td>Ann<\/td>/);
    assert.match(html, /<td>25<\/td>/);
  });

  it("renders unordered and ordered lists", () => {
    assert.match(renderMdxApprox("- a\n- b"), /<ul class="mdx-list"><li>a<\/li><li>b<\/li><\/ul>/);
    assert.match(renderMdxApprox("1. one\n2. two"), /<ol class="mdx-list"><li>one<\/li><li>two<\/li><\/ol>/);
  });

  it("renders fenced code blocks with content escaped", () => {
    const html = renderMdxApprox("```ts\nconst x = 1 < 2;\n```");
    assert.match(html, /<pre class="mdx-code" data-lang="ts"><code>const x = 1 &lt; 2;<\/code><\/pre>/);
  });

  it("renders a JSX component as a labeled box with props and children", () => {
    const md = `<Callout type="info" dismissable>\n\nHello **world**\n\n</Callout>`;
    const html = renderMdxApprox(md);
    assert.match(html, /<div class="mdx-jsx-head">Callout<\/div>/);
    assert.match(html, /<span class="k">type<\/span>=<span class="v">info<\/span>/);
    assert.match(html, /<span class="k">dismissable<\/span>/);
    assert.match(html, /<div class="mdx-jsx-children">/);
    assert.match(html, /<strong>world<\/strong>/);
  });

  it("renders a self-closing JSX component", () => {
    const html = renderMdxApprox(`<Divider spacing="lg" />`);
    assert.match(html, /<div class="mdx-jsx-head">Divider<\/div>/);
    assert.match(html, /<span class="k">spacing<\/span>=<span class="v">lg<\/span>/);
    assert.doesNotMatch(html, /mdx-jsx-children/);
  });

  it("keeps <script> injection escaped, never emitting a raw tag", () => {
    const html = renderMdxApprox("Danger: <script>alert('xss')</script> end.");
    assert.match(html, /&lt;script&gt;/);
    assert.doesNotMatch(html, /<script>/);
  });

  it("escapes JSX prop values and children (no injected markup)", () => {
    const html = renderMdxApprox(`<Box label="<b>x</b>">\n<img onerror="hack">\n</Box>`);
    assert.doesNotMatch(html, /<b>x<\/b>/);
    assert.doesNotMatch(html, /<img onerror/);
    assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);
  });

  it("falls back without throwing on malformed JSX", () => {
    assert.doesNotThrow(() => renderMdxApprox("<Foo bar={unclosed\n\nmore text"));
    const html = renderMdxApprox("<Unclosed>\nno closing tag here");
    assert.equal(typeof html, "string");
  });
});
