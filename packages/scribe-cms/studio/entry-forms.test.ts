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
import type { ContentTypeInput, ScribeProject } from "../src/core/types.js";
import { formFieldsFor, renderEntryForm, slugSourceField, type EntryFormContext } from "./entry-forms.js";

interface DocSpec {
  slug: string;
  data: Record<string, unknown>;
}

function build(types: ContentTypeInput[], docs: Record<string, DocSpec[]> = {}): ScribeProject {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-form-"));
  for (const type of types) {
    const dir = path.join(rootDir, "content", type.contentDir ?? type.id);
    fs.mkdirSync(dir, { recursive: true });
    for (const doc of docs[type.id] ?? []) {
      fs.writeFileSync(path.join(dir, `${doc.slug}.mdx`), matter.stringify("", doc.data), "utf8");
    }
  }
  const config = resolveConfig({ rootDir, locales: ["en"], assets: { dir: "public" }, types });
  openStore(config, "readwrite").close();
  return createProject(config);
}

const allKindsSchema = z.object({
  title: field.translatable(z.string().describe("The display title")),
  count: field.structural(z.number().optional()),
  featured: field.structural(z.boolean().optional()),
  status: field.structural(z.enum(["draft", "live"])),
  author: field.relation("author", { optional: true }),
  editor: field.relation("author"),
  tags: field.relation("tag", { multiple: true }),
  hero: field.asset({ template: "/looks/{slug}/hero.webp", formats: ["webp"] }),
  gallery: field.asset({ dir: "/g", multiple: true }),
  seo: field.structural(z.object({ metaTitle: z.string() }).optional()),
});

function makeProject(): ScribeProject {
  return build(
    [
      { id: "look", schema: allKindsSchema },
      { id: "author", schema: z.object({ name: field.structural(z.string()) }) },
      { id: "tag", schema: z.object({ label: field.structural(z.string()) }) },
    ],
    {
      author: [{ slug: "jane", data: { name: "Jane" } }],
      tag: [{ slug: "summer", data: { label: "Summer" } }],
    },
  );
}

function ctxFor(
  project: ScribeProject,
  over: Partial<EntryFormContext> = {},
): EntryFormContext {
  const type = project.getType("look");
  return {
    project,
    config: project.config,
    type,
    mode: "create",
    slug: "",
    values: {},
    body: "",
    postAction: "/types/look/new",
    cancelHref: "/types/look",
    ...over,
  };
}

describe("formFieldsFor", () => {
  it("classifies every top-level field kind, nested object → yaml", () => {
    const fields = formFieldsFor(allKindsSchema);
    const byKey = new Map(fields.map((f) => [f.key, f]));
    assert.equal(byKey.get("title")?.kind, "text");
    assert.equal(byKey.get("title")?.translatable, true);
    assert.equal(byKey.get("count")?.kind, "number");
    assert.equal(byKey.get("featured")?.kind, "boolean");
    assert.equal(byKey.get("status")?.kind, "enum");
    assert.deepEqual(byKey.get("status")?.enumOptions, ["draft", "live"]);
    assert.equal(byKey.get("author")?.kind, "relation");
    assert.equal(byKey.get("author")?.relationMultiple, false);
    assert.equal(byKey.get("author")?.optional, true);
    assert.equal(byKey.get("editor")?.kind, "relation");
    assert.equal(byKey.get("editor")?.optional, false);
    assert.equal(byKey.get("tags")?.relationMultiple, true);
    assert.equal(byKey.get("hero")?.kind, "asset");
    assert.equal(byKey.get("gallery")?.asset?.multiple, true);
    assert.equal(byKey.get("seo")?.kind, "yaml");
    // Declaration order preserved.
    assert.deepEqual(
      fields.map((f) => f.key),
      ["title", "count", "featured", "status", "author", "editor", "tags", "hero", "gallery", "seo"],
    );
  });

  it("picks the first translatable string as the slug source", () => {
    assert.equal(slugSourceField(formFieldsFor(allKindsSchema))?.key, "title");
  });
});

describe("renderEntryForm — widgets", () => {
  const project = makeProject();
  const html = renderEntryForm(ctxFor(project));

  it("renders a text input for a string field", () => {
    assert.match(html, /name="f:title"/);
    assert.match(html, /type="text"[^>]*name="f:title"|name="f:title"[^>]*type="text"/);
  });
  it("renders a number input", () => {
    assert.match(html, /type="number"[^>]*name="f:count"/);
  });
  it("renders a checkbox for a boolean", () => {
    assert.match(html, /type="checkbox"[^>]*name="f:featured"/);
  });
  it("renders a select with the enum options", () => {
    assert.match(html, /name="f:status"/);
    assert.match(html, /<option value="draft">draft<\/option>/);
    assert.match(html, /<option value="live">live<\/option>/);
  });
  it("renders a single relation as radio rows of target entries", () => {
    assert.match(html, /type="radio"[^>]*name="f:author"[^>]*value="jane"/);
    assert.match(html, /class="rel-picker"/);
    assert.match(html, /class="rel-options"/);
  });
  it("renders a '— none —' radio row for an optional single relation, checked by default", () => {
    assert.match(html, /class="rel-option rel-none"><input type="radio" name="f:author" value="" checked/);
  });
  it("does not render a '— none —' row for a required single relation, and no row starts checked", () => {
    const editorPicker = html.split('name="f:editor"');
    // Only one radio group entry for the single target doc, no empty-value row.
    assert.doesNotMatch(html, /name="f:editor" value=""/);
    assert.doesNotMatch(html, /name="f:editor"[^>]*checked/);
    assert.equal(editorPicker.length, 2);
  });
  it("renders a multiple relation as checkbox rows in the picker", () => {
    assert.match(html, /type="checkbox"[^>]*name="f:tags"[^>]*value="summer"/);
    assert.doesNotMatch(html, /name="f:tags"[^>]*value=""/);
  });
  it("omits the filter input for small option lists", () => {
    // The inline script always mentions the .rel-filter selector; only the
    // rendered markup must be free of filter inputs and counts.
    assert.doesNotMatch(html, /class="rel-filter"/);
    assert.doesNotMatch(html, /class="rel-count"/);
  });
  it("renders a single asset as a file input with the templated destination", () => {
    assert.match(html, /type="file"[^>]*name="file:hero"/);
    assert.match(html, /data-template="\/looks\/\{slug\}\/hero\.webp"/);
  });
  it("renders a multiple asset as a multi file input", () => {
    assert.match(html, /<input type="file" multiple name="file:gallery"/);
  });
  it("renders a YAML textarea for a nested object", () => {
    assert.match(html, /name="yaml:seo"/);
    assert.match(html, /class="yaml"/);
  });
  it("shows the field description as help text", () => {
    assert.match(html, /The display title/);
  });
  it("shows a body textarea for a body-carrying type", () => {
    assert.match(html, /name="body"/);
    assert.match(html, /class="body-editor"/);
  });
});

describe("renderEntryForm — relation picker filter", () => {
  it("renders the filter input and count only when the list has more than 8 options", () => {
    const tagDocs = Array.from({ length: 9 }, (_, i) => ({
      slug: `tag-${i}`,
      data: { label: `Tag ${i}` },
    }));
    const project = build(
      [
        { id: "look", schema: allKindsSchema },
        { id: "author", schema: z.object({ name: field.structural(z.string()) }) },
        { id: "tag", schema: z.object({ label: field.structural(z.string()) }) },
      ],
      { author: [{ slug: "jane", data: { name: "Jane" } }], tag: tagDocs },
    );
    const html = renderEntryForm(ctxFor(project));
    // tags picker (9 options) gets a filter + "9 of 9" count…
    assert.match(html, /<input type="search" class="rel-filter" placeholder="Filter…"/);
    assert.match(html, /class="rel-count">9 of 9</);
    // …the filter input must never be submitted with the form.
    assert.doesNotMatch(html, /class="rel-filter"[^>]*name=/);
    assert.doesNotMatch(html, /name="[^"]*"[^>]*class="rel-filter"/);
    // author picker (1 option) stays plain: exactly one filter input in the page.
    assert.equal(html.split('class="rel-filter"').length, 2);
  });
});

describe("renderEntryForm — slug behavior", () => {
  const project = makeProject();

  it("slug input is editable on create (not readonly)", () => {
    const html = renderEntryForm(ctxFor(project, { mode: "create" }));
    assert.match(html, /name="slug"/);
    assert.doesNotMatch(html, /name="slug"[^>]*readonly/);
  });

  it("slug input is read-only on edit and shows the current slug", () => {
    const html = renderEntryForm(ctxFor(project, { mode: "edit", slug: "sunset" }));
    assert.match(html, /name="slug"[^>]*value="sunset"[^>]*readonly|name="slug"[^>]*readonly/);
    assert.match(html, /value="sunset"/);
  });

  it("computes the templated destination from a concrete slug", () => {
    const html = renderEntryForm(ctxFor(project, { mode: "edit", slug: "sunset" }));
    assert.match(html, /\/looks\/sunset\/hero\.webp/);
  });
});

describe("renderEntryForm — prefill and errors", () => {
  const project = makeProject();

  it("prefills field values on edit", () => {
    const html = renderEntryForm(
      ctxFor(project, {
        mode: "edit",
        slug: "sunset",
        values: { title: "Sunset Look", status: "live" },
      }),
    );
    assert.match(html, /name="f:title"[^>]*value="Sunset Look"/);
    assert.match(html, /<option value="live" selected>/);
  });

  it("prefills a single relation: matching radio checked, '— none —' unchecked", () => {
    const html = renderEntryForm(
      ctxFor(project, { mode: "edit", slug: "sunset", values: { author: "jane" } }),
    );
    assert.match(html, /type="radio"[^>]*name="f:author"[^>]*value="jane" checked/);
    assert.doesNotMatch(html, /name="f:author" value="" checked/);
  });

  it("prefills a multiple relation: current slugs are checked", () => {
    const html = renderEntryForm(
      ctxFor(project, { mode: "edit", slug: "sunset", values: { tags: ["summer"] } }),
    );
    assert.match(html, /type="checkbox"[^>]*name="f:tags"[^>]*value="summer" checked/);
  });

  it("re-renders submitted values and per-field error messages", () => {
    const html = renderEntryForm(
      ctxFor(project, {
        values: { title: "Kept title" },
        errors: { title: "Something is wrong", _form: "Fix the errors below" },
      }),
    );
    assert.match(html, /value="Kept title"/);
    assert.match(html, /Something is wrong/);
    assert.match(html, /Fix the errors below/);
  });
});
