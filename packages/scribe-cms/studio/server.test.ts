import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import matter from "gray-matter";
import { field } from "../src/core/field.js";
import { resolveConfig } from "../src/config/resolve-config.js";
import { createProject } from "../src/create-project.js";
import { openStore } from "../src/storage/sqlite.js";
import type { ContentTypeInput } from "../src/core/types.js";
import { createStudioApp } from "./server.js";

interface DocSpec {
  slug: string;
  data: Record<string, unknown>;
  body?: string;
}

/** Build a throwaway project on disk from inline type defs + documents. */
function build(types: ContentTypeInput[], docs: Record<string, DocSpec[]>) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-studio-"));
  for (const type of types) {
    const dir = path.join(rootDir, "content", type.contentDir ?? type.id);
    fs.mkdirSync(dir, { recursive: true });
    for (const doc of docs[type.id] ?? []) {
      fs.writeFileSync(
        path.join(dir, `${doc.slug}.mdx`),
        matter.stringify(doc.body ?? "", doc.data),
        "utf8",
      );
    }
  }
  const config = resolveConfig({ rootDir, locales: ["en", "fr"], types });
  openStore(config, "readwrite").close();
  return createProject(config);
}

/** A project with a translatable type (`post`) and a bodyless one (`author`). */
function sampleApp() {
  const project = build(
    [
      { id: "post", label: "Posts", schema: z.object({ title: field.translatable(z.string()) }) },
      { id: "author", label: "Authors", body: false, schema: z.object({ name: z.string() }) },
    ],
    {
      post: [
        { slug: "hello", data: { title: "Hello" }, body: "# Hi" },
        { slug: "world", data: { title: "World" }, body: "# Yo" },
      ],
      author: [{ slug: "ada", data: { name: "Ada" } }],
    },
  );
  return createStudioApp(project);
}

describe("studio content home (/)", () => {
  it("renders a type card per type with entry counts and New links", async () => {
    const app = sampleApp();
    const html = await (await app.request("/")).text();
    // Both type labels appear as cards.
    assert.match(html, /Posts/);
    assert.match(html, /Authors/);
    // Entry counts (2 posts, 1 author) and correct pluralization.
    assert.match(html, /2 entries/);
    assert.match(html, /1 entry/);
    // Card body links + per-card "+ New" links.
    assert.match(html, /class="home-card-main" href="\/types\/post"/);
    assert.match(html, /class="home-card-new" href="\/types\/post\/new"/);
    assert.match(html, /class="home-card-new" href="\/types\/author\/new"/);
    // Bodyless type is flagged not-translatable on its card.
    assert.match(html, /not translatable/);
  });

  it("marks the Content activity-bar item active and drops legacy nav items", async () => {
    const app = sampleApp();
    const html = await (await app.request("/")).text();
    assert.match(html, /<a href="\/" title="Content" class="active">/);
    assert.match(html, /<a href="\/translations" title="Translations"/);
    // Legacy dashboard/staleness nav items are gone.
    assert.doesNotMatch(html, /href="\/dashboard"/);
    assert.doesNotMatch(html, /title="Staleness"/);
    // Sidebar per-type "+" affordance links to the new-entry form.
    assert.match(html, /class="tree-new" href="\/types\/post\/new"/);
  });
});

describe("studio translations section (/translations)", () => {
  it("renders the Coverage tab by default, active, with coverage tables", async () => {
    const app = sampleApp();
    const html = await (await app.request("/translations")).text();
    assert.match(html, /<a class="tab active" href="\/translations">Coverage<\/a>/);
    assert.match(html, /<a class="tab" href="\/translations\?tab=staleness">Staleness<\/a>/);
    // Coverage panel sections.
    assert.match(html, /Locales/);
    assert.match(html, /Types/);
    // Translations activity-bar item is active.
    assert.match(html, /<a href="\/translations" title="Translations" class="active">/);
  });

  it("renders the Staleness tab when ?tab=staleness", async () => {
    const app = sampleApp();
    const html = await (await app.request("/translations?tab=staleness")).text();
    assert.match(html, /<a class="tab active" href="\/translations\?tab=staleness">Staleness<\/a>/);
    assert.match(html, /stale or missing/);
  });

  it("serves the staleness matrix JSON feed", async () => {
    const app = sampleApp();
    const res = await app.request("/api/staleness-matrix");
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, Record<string, number>>;
    // Translatable type has an fr column; every entry is missing a translation.
    assert.equal(body.post!.fr, 2);
  });
});

describe("studio inspector translations tab", () => {
  it("shows Details by default and a Translations view tab for translatable types", async () => {
    const app = sampleApp();
    const html = await (await app.request("/types/post/hello")).text();
    assert.match(html, /<a class="tab active" href="\/types\/post\/hello">Details<\/a>/);
    assert.match(html, /href="\/types\/post\/hello\?tab=translations">Translations<\/a>/);
    // Default view shows the Fields section.
    assert.match(html, /<div class="section-head">Fields<\/div>/);
  });

  it("renders the per-locale translation detail under ?tab=translations", async () => {
    const app = sampleApp();
    const html = await (await app.request("/types/post/hello?tab=translations")).text();
    // Translations view tab is now active.
    assert.match(html, /<a class="tab active" href="\/types\/post\/hello\?tab=translations">Translations<\/a>/);
    // The default-locale (source) detail renders the frontmatter panel.
    assert.match(html, /Frontmatter/);
    // Fr locale has no stored translation yet.
    const frHtml = await (
      await app.request("/types/post/hello?tab=translations&locale=fr")
    ).text();
    assert.match(frHtml, /No translation for fr/);
  });

  it("does not offer a Translations tab for non-translatable types", async () => {
    const app = sampleApp();
    const html = await (await app.request("/types/author/ada")).text();
    assert.doesNotMatch(html, /tab=translations/);
  });
});

describe("studio legacy route redirects", () => {
  const cases: Array<[string, string]> = [
    ["/dashboard", "/translations"],
    ["/staleness", "/translations?tab=staleness"],
    ["/type/post", "/types/post"],
    ["/type/post/doc/hello", "/types/post/hello?tab=translations"],
  ];
  for (const [from, to] of cases) {
    it(`301-redirects ${from} → ${to}`, async () => {
      const app = sampleApp();
      const res = await app.request(from);
      assert.equal(res.status, 301);
      assert.equal(res.headers.get("location"), to);
    });
  }

  it("preserves the locale query when redirecting a doc route", async () => {
    const app = sampleApp();
    const res = await app.request("/type/post/doc/hello?locale=fr");
    assert.equal(res.status, 301);
    assert.equal(res.headers.get("location"), "/types/post/hello?tab=translations&locale=fr");
  });
});
