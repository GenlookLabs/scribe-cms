import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractInlineTokens } from "../src/inline/tokens.js";
import { renderMdxApprox } from "./mdx-preview.js";
import { buildPreviewTokens } from "./preview-tokens.js";

function preview(
  body: string,
  opts: {
    enFrontmatter?: Record<string, unknown>;
    docExists?: (typeId: string, enSlug: string) => boolean;
  } = {},
): string {
  const { placeholderBody, tokens } = extractInlineTokens(body);
  const pv = buildPreviewTokens(tokens, {
    enFrontmatter: opts.enFrontmatter ?? {},
    docExists: opts.docExists ?? (() => true),
  });
  return renderMdxApprox(placeholderBody, pv);
}

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

  it("renders a JSX component as raw escaped source", () => {
    const md = `<Callout type="info" dismissable>\n\nHello **world**\n\n</Callout>`;
    const html = renderMdxApprox(md);
    assert.match(html, /<pre class="mdx-jsx-raw"><code>/);
    assert.match(html, /&lt;Callout type=&quot;info&quot; dismissable&gt;/);
    assert.match(html, /Hello \*\*world\*\*/);
    assert.doesNotMatch(html, /mdx-jsx-head/);
    assert.doesNotMatch(html, /mdx-jsx-props/);
  });

  it("renders a self-closing JSX component as raw escaped source", () => {
    const html = renderMdxApprox(`<Divider spacing="lg" />`);
    assert.match(html, /<pre class="mdx-jsx-raw"><code>&lt;Divider spacing=&quot;lg&quot; \/&gt;<\/code><\/pre>/);
    assert.doesNotMatch(html, /mdx-jsx-head/);
  });

  it("keeps <script> injection escaped, never emitting a raw tag", () => {
    const html = renderMdxApprox("Danger: <script>alert('xss')</script> end.");
    assert.match(html, /&lt;script&gt;/);
    assert.doesNotMatch(html, /<script>/);
  });

  it("escapes JSX prop values and children in raw blocks (no injected markup)", () => {
    const html = renderMdxApprox(`<Box label="<b>x</b>">\n<img onerror="hack">\n</Box>`);
    assert.doesNotMatch(html, /<b>x<\/b>/);
    assert.doesNotMatch(html, /<img onerror/);
    assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);
    assert.match(html, /mdx-jsx-raw/);
  });

  it("falls back without throwing on malformed JSX", () => {
    assert.doesNotThrow(() => renderMdxApprox("<Foo bar={unclosed\n\nmore text"));
    const html = renderMdxApprox("<Unclosed>\nno closing tag here");
    assert.equal(typeof html, "string");
  });

  it("renders a relation token in a markdown link dest as a studio anchor", () => {
    const html = preview("[label](${{relation:glossary:foo}})");
    assert.match(
      html,
      /<a class="mdx-relation-link" href="\/type\/glossary\/doc\/foo">label<\/a>/,
    );
  });

  it("renders a standalone relation token as a chip link", () => {
    const html = preview("See ${{relation:glossary:foo}}.");
    assert.match(
      html,
      /<a class="mdx-relation-chip" href="\/type\/glossary\/doc\/foo">foo<\/a>/,
    );
  });

  it("renders a dangling relation as broken, without a live href", () => {
    const html = preview("[label](${{relation:glossary:foo}})", { docExists: () => false });
    assert.match(html, /<span class="mdx-relation-broken" title="missing target">label<\/span>/);
    assert.doesNotMatch(html, /<a class="mdx-relation-link"/);
  });

  it("renders an asset token in an image dest", () => {
    const html = preview("![alt](${{asset:/img/x.webp}})");
    assert.match(html, /<img class="mdx-img" src="\/img\/x\.webp" alt="alt"/);
  });

  it("renders a plain markdown image with a root-relative path", () => {
    const html = renderMdxApprox("![a](/glossary-images/x.webp)");
    assert.match(html, /<img class="mdx-img" src="\/glossary-images\/x\.webp" alt="a"/);
  });

  it("renders a static token as its resolved value", () => {
    const html = preview('Price: ${{static:"$9"}}.');
    assert.match(html, /Price: \$9\./);
    assert.doesNotMatch(html, /\$\{\{/);
  });

  it("renders a var token from enFrontmatter.vars", () => {
    const html = preview("CTA: ${{var:cta}}.", { enFrontmatter: { vars: { cta: "Shop now" } } });
    assert.match(html, /CTA: Shop now\./);
  });

  it("renders a JSX block with a slug-mode relation prop as raw source with a relation link", () => {
    const html = preview('<E slug="${{relation:glossary:foo:slug}}" />');
    assert.match(html, /<pre class="mdx-jsx-raw"><code>/);
    assert.match(html, /&lt;E slug=&quot;/);
    assert.match(
      html,
      /<a class="mdx-relation-link" href="\/type\/glossary\/doc\/foo">\$\{\{relation:glossary:foo:slug\}\}<\/a>/,
    );
  });

  it("leaves a malformed token verbatim and escaped, not swallowed", () => {
    const html = renderMdxApprox("Bad: ${{bogus}} here.");
    assert.match(html, /\$\{\{bogus\}\}/);
    assert.doesNotMatch(html, /mdx-relation/);
  });
});
