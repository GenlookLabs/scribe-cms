import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ScribeDocument } from "../src/core/types.js";
import { renderSearchPage, searchProject } from "./search.js";

function doc(slug: string, frontmatter: Record<string, unknown>, content = ""): ScribeDocument {
  return { slug, enSlug: slug, locale: "en", frontmatter, content } as unknown as ScribeDocument;
}

function fakeType(id: string, label: string, docs: ScribeDocument[]) {
  return { id, config: { label }, list: () => docs };
}

function fakeProject(types: ReturnType<typeof fakeType>[]) {
  return { listTypes: () => types };
}

describe("searchProject", () => {
  const project = fakeProject([
    fakeType("vertical", "Verticals", [
      doc("denim", { title: "Denim jackets" }, "All about denim."),
      doc("dresses", { title: "Summer dresses" }, "Nothing here."),
    ]),
    fakeType("blog", "Blog", [
      doc("post-a", { title: "A denim story", tags: ["denim", "style"] }, "Body text."),
    ]),
  ]);

  it("groups hits by type and only includes types with matches", () => {
    const groups = searchProject(project, "denim");
    assert.equal(groups.length, 2);
    const verticals = groups.find((g) => g.typeId === "vertical")!;
    assert.equal(verticals.label, "Verticals");
    assert.deepEqual(verticals.hits.map((h) => h.enSlug), ["denim"]);
    const blog = groups.find((g) => g.typeId === "blog")!;
    assert.equal(blog.hits[0]!.field, "title");
  });

  it("matches on slug, frontmatter, and body, reporting where", () => {
    const single = fakeProject([
      fakeType("t", "T", [
        doc("only-body", { title: "x" }, "hidden denim inside body"),
      ]),
    ]);
    const groups = searchProject(single, "denim");
    assert.equal(groups[0]!.hits[0]!.field, "body");
  });

  it("is case-insensitive", () => {
    assert.equal(searchProject(project, "DENIM").length, 2);
  });

  it("returns nothing for an empty query", () => {
    assert.deepEqual(searchProject(project, "   "), []);
  });

  it("builds snippets that wrap the match in <mark>", () => {
    const groups = searchProject(project, "denim");
    const snip = groups[0]!.hits[0]!.snippet;
    assert.match(snip, /<mark>[Dd]enim<\/mark>/);
  });
});

describe("renderSearchPage", () => {
  it("renders grouped hits with type headers", () => {
    const project = fakeProject([
      fakeType("vertical", "Verticals", [doc("denim", { title: "Denim" })]),
    ]);
    const html = renderSearchPage(project, "denim");
    assert.match(html, /Verticals/);
    assert.match(html, /class="search-hit"/);
    assert.match(html, /href="\/types\/vertical\/denim"/);
    assert.match(html, /<mark>/);
  });

  it("caps hits at 20 per type with a +N more row", () => {
    const docs = Array.from({ length: 25 }, (_, i) => doc(`item-${i}`, { title: `denim ${i}` }));
    const project = fakeProject([fakeType("t", "T", docs)]);
    const groups = searchProject(project, "denim");
    assert.equal(groups[0]!.total, 25);
    assert.equal(groups[0]!.hits.length, 20);
    const html = renderSearchPage(project, "denim");
    assert.match(html, /\+5 more matches/);
  });

  it("escapes the query and matched HTML in the snippet (escape-before-mark)", () => {
    const project = fakeProject([
      fakeType("t", "T", [doc("x", { title: "a <script>alert(1)</script> b" })]),
    ]);
    const html = renderSearchPage(project, "<script>");
    // Echoed query is escaped in the toolbar.
    assert.match(html, /&lt;script&gt;/);
    assert.doesNotMatch(html, /<script>/);
    // The match itself is escaped inside the <mark>.
    assert.match(html, /<mark>&lt;script&gt;<\/mark>/);
  });

  it("renders just a prompt for an empty query", () => {
    const project = fakeProject([fakeType("t", "T", [doc("x", { title: "y" })])]);
    const html = renderSearchPage(project, "");
    assert.match(html, /Type a query/);
    assert.doesNotMatch(html, /search-group/);
  });
});
