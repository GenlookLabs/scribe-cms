import assert from "node:assert/strict";
import { test } from "node:test";
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
import { formFieldsFor } from "./entry-forms.js";
import {
  formValuesFromInput,
  writeEntry,
  type EntryFormInput,
  type UploadedFile,
} from "./entry-write.js";

interface DocSpec {
  slug: string;
  data: Record<string, unknown>;
  body?: string;
}

/** Build a throwaway on-disk project from inline type defs + documents. */
function build(
  types: ContentTypeInput[],
  docs: Record<string, DocSpec[]> = {},
  opts: { assets?: boolean } = {},
): { project: ScribeProject; rootDir: string; assetsPath: string } {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-write-"));
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
  const config = resolveConfig({
    rootDir,
    locales: ["en"],
    assets: opts.assets ? { dir: "public" } : undefined,
    types,
  });
  openStore(config, "readwrite").close();
  return {
    project: createProject(config),
    rootDir,
    assetsPath: config.assets?.assetsPath ?? path.join(rootDir, "public"),
  };
}

function upload(name: string, sizeBytes = 8): UploadedFile {
  const bytes = Buffer.alloc(sizeBytes, 0x61);
  return { filename: name, ext: name.split(".").pop()!.toLowerCase(), size: bytes.length, bytes };
}

function emptyInput(over: Partial<EntryFormInput> = {}): EntryFormInput {
  return { slug: "", body: "", fields: {}, yaml: {}, files: {}, removedAssets: {}, ...over };
}

test("create happy path writes the entry file and a templated asset file", () => {
  const { project, rootDir, assetsPath } = build(
    [
      {
        id: "look",
        schema: z.object({
          title: field.translatable(z.string()),
          hero: field.asset({ template: "/looks/{slug}/hero.webp", formats: ["webp"] }),
        }),
      },
    ],
    {},
    { assets: true },
  );
  const type = project.getType("look");
  const result = writeEntry(project, type, "create", {
    ...emptyInput(),
    slug: "sunset",
    body: "Hello body",
    fields: { title: "Sunset Look" },
    files: { hero: [upload("h.webp")] },
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));

  const filePath = path.join(rootDir, "content", "look", "sunset.mdx");
  assert.ok(fs.existsSync(filePath));
  const parsed = matter(fs.readFileSync(filePath, "utf8"));
  assert.equal(parsed.data.title, "Sunset Look");
  // Templated asset field is omitted from frontmatter (loader materializes it).
  assert.equal("hero" in parsed.data, false);
  assert.match(parsed.content, /Hello body/);
  // The uploaded image lands at the materialized destination.
  assert.ok(fs.existsSync(path.join(assetsPath, "looks", "sunset", "hero.webp")));
});

test("create always writes .mdx, even into an existing .md corpus", () => {
  const { project, rootDir } = build([
    { id: "post", schema: z.object({ title: field.translatable(z.string()) }) },
  ]);
  // Seed a legacy .md entry: Scribe reads .md but only ever creates .mdx.
  fs.writeFileSync(
    path.join(rootDir, "content", "post", "legacy.md"),
    matter.stringify("", { title: "Legacy" }),
    "utf8",
  );
  const type = project.getType("post");
  const result = writeEntry(project, type, "create", {
    ...emptyInput(),
    slug: "three",
    fields: { title: "Three" },
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.ok(fs.existsSync(path.join(rootDir, "content", "post", "three.mdx")));
  assert.equal(fs.existsSync(path.join(rootDir, "content", "post", "three.md")), false);
});

test("dir-based single asset writes {slug}.{ext} and stores the web path", () => {
  const { project, rootDir, assetsPath } = build(
    [
      {
        id: "look",
        schema: z.object({
          title: field.translatable(z.string()),
          photo: field.asset({ dir: "/photos", formats: ["png"] }),
        }),
      },
    ],
    {},
    { assets: true },
  );
  const type = project.getType("look");
  const result = writeEntry(project, type, "create", {
    ...emptyInput(),
    slug: "a",
    fields: { title: "A" },
    files: { photo: [upload("x.png")] },
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const parsed = matter(fs.readFileSync(path.join(rootDir, "content", "look", "a.mdx"), "utf8"));
  assert.equal(parsed.data.photo, "/photos/a.png");
  assert.ok(fs.existsSync(path.join(assetsPath, "photos", "a.png")));
});

test("validation failure keeps values and writes nothing", () => {
  const { project, rootDir } = build([
    { id: "post", schema: z.object({ title: field.translatable(z.string()), n: field.structural(z.number()) }) },
  ]);
  const type = project.getType("post");
  const fields = formFieldsFor(type.config.schema);
  const input = emptyInput({ slug: "keep", fields: { title: "Keep me", n: "" } });
  const result = writeEntry(project, type, "create", input);
  assert.equal(result.ok, false);
  assert.ok(result.errors?.n, "missing required number should error");
  // No file written.
  assert.equal(fs.existsSync(path.join(rootDir, "content", "post", "keep.mdx")), false);
  // Submitted values survive for the re-render.
  const values = formValuesFromInput(fields, input);
  assert.equal(values.title, "Keep me");
});

test("slug collision against existing entries and redirect aliases is rejected", () => {
  const { project, rootDir } = build(
    [{ id: "post", schema: z.object({ title: field.translatable(z.string()) }) }],
    { post: [{ slug: "hello", data: { title: "Hello" } }] },
  );
  // Add a redirect alias file.
  fs.writeFileSync(
    path.join(rootDir, "content", "post", "_redirects.json"),
    JSON.stringify({ redirects: [{ from: "legacy", toSlug: "hello" }] }),
    "utf8",
  );
  const type = project.getType("post");

  const collideEntry = writeEntry(project, type, "create", emptyInput({ slug: "hello", fields: { title: "X" } }));
  assert.equal(collideEntry.ok, false);
  assert.ok(collideEntry.errors?.slug);

  const collideAlias = writeEntry(project, type, "create", emptyInput({ slug: "legacy", fields: { title: "X" } }));
  assert.equal(collideAlias.ok, false);
  assert.ok(collideAlias.errors?.slug);
});

test("relation target must exist", () => {
  const { project } = build([
    { id: "author", schema: z.object({ name: field.structural(z.string()) }) },
    { id: "post", schema: z.object({ title: field.translatable(z.string()), author: field.relation("author") }) },
  ]);
  const type = project.getType("post");
  const result = writeEntry(project, type, "create", emptyInput({ slug: "p", fields: { title: "P", author: "ghost" } }));
  assert.equal(result.ok, false);
  assert.ok(result.errors?.author);
});

test("multiple-asset create then edit: keep/remove/append ordering", () => {
  const { project, rootDir } = build(
    [
      {
        id: "look",
        schema: z.object({
          title: field.translatable(z.string()),
          gallery: field.asset({ dir: "/g", multiple: true }),
        }),
      },
    ],
    {},
    { assets: true },
  );
  const type = project.getType("look");

  const created = writeEntry(project, type, "create", {
    ...emptyInput(),
    slug: "a",
    fields: { title: "A" },
    files: { gallery: [upload("1.png"), upload("2.png"), upload("3.png")] },
  });
  assert.equal(created.ok, true, JSON.stringify(created.errors));
  let parsed = matter(fs.readFileSync(path.join(rootDir, "content", "look", "a.mdx"), "utf8"));
  assert.deepEqual(parsed.data.gallery, ["/g/a-0.png", "/g/a-1.png", "/g/a-2.png"]);

  // Edit: remove index 1 (a-1), append one new. New continues after highest kept (a-2 → a-3).
  const edited = writeEntry(project, type, "edit", {
    ...emptyInput(),
    slug: "a",
    fields: { title: "A" },
    files: { gallery: [upload("new.png")] },
    removedAssets: { gallery: new Set([1]) },
  });
  assert.equal(edited.ok, true, JSON.stringify(edited.errors));
  parsed = matter(fs.readFileSync(path.join(rootDir, "content", "look", "a.mdx"), "utf8"));
  assert.deepEqual(parsed.data.gallery, ["/g/a-0.png", "/g/a-2.png", "/g/a-3.png"]);
});

test("edit preserves unmanaged keys and body bytes; body change is honored", () => {
  const { project, rootDir } = build([
    { id: "post", schema: z.object({ title: field.translatable(z.string()) }) },
  ]);
  const file = path.join(rootDir, "content", "post", "x.mdx");
  // Author-written file with an unmanaged builtin key + a body.
  fs.writeFileSync(file, matter.stringify("Original body", { title: "Old", publishedAt: "2024-01-01" }), "utf8");
  const existingBody = matter(fs.readFileSync(file, "utf8")).content;
  const type = project.getType("post");

  // Edit title, keep the body identical → unmanaged key preserved, body untouched.
  const r1 = writeEntry(project, type, "edit", emptyInput({ slug: "x", body: existingBody, fields: { title: "New" } }));
  assert.equal(r1.ok, true, JSON.stringify(r1.errors));
  let parsed = matter(fs.readFileSync(file, "utf8"));
  assert.equal(parsed.data.title, "New");
  assert.equal(parsed.data.publishedAt, "2024-01-01");
  assert.equal(parsed.content, existingBody);

  // Change the body.
  const r2 = writeEntry(project, type, "edit", emptyInput({ slug: "x", body: "Rewritten body", fields: { title: "New" } }));
  assert.equal(r2.ok, true, JSON.stringify(r2.errors));
  parsed = matter(fs.readFileSync(file, "utf8"));
  assert.match(parsed.content, /Rewritten body/);
  assert.equal(parsed.data.publishedAt, "2024-01-01");
});

test("edit clears an optional field that was emptied", () => {
  const { project, rootDir } = build([
    { id: "post", schema: z.object({ title: field.translatable(z.string()), subtitle: field.translatable(z.string().optional()) }) },
  ]);
  const file = path.join(rootDir, "content", "post", "x.mdx");
  fs.writeFileSync(file, matter.stringify("body", { title: "T", subtitle: "was here" }), "utf8");
  const type = project.getType("post");
  const r = writeEntry(project, type, "edit", emptyInput({ slug: "x", body: "body", fields: { title: "T", subtitle: "" } }));
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const parsed = matter(fs.readFileSync(file, "utf8"));
  assert.equal("subtitle" in parsed.data, false);
});

test("wrong-format and oversized uploads are rejected without conversion", () => {
  const { project, assetsPath } = build(
    [
      {
        id: "look",
        schema: z.object({
          title: field.translatable(z.string()),
          hero: field.asset({ dir: "/i", formats: ["webp"], maxKB: 1 }),
        }),
      },
    ],
    {},
    { assets: true },
  );
  const type = project.getType("look");

  const wrongFormat = writeEntry(project, type, "create", {
    ...emptyInput(),
    slug: "a",
    fields: { title: "A" },
    files: { hero: [upload("h.png")] },
  });
  assert.equal(wrongFormat.ok, false);
  assert.match(wrongFormat.errors?.hero ?? "", /format/i);

  const oversized = writeEntry(project, type, "create", {
    ...emptyInput(),
    slug: "b",
    fields: { title: "B" },
    files: { hero: [upload("h.webp", 2048)] },
  });
  assert.equal(oversized.ok, false);
  assert.match(oversized.errors?.hero ?? "", /budget/i);

  // Nothing was written on either rejection.
  assert.equal(fs.existsSync(path.join(assetsPath, "i", "a.png")), false);
  assert.equal(fs.existsSync(path.join(assetsPath, "i", "b.webp")), false);
});
