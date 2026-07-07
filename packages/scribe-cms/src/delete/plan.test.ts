import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import matter from "gray-matter";
import { field } from "../core/field.js";
import { resolveConfig } from "../config/resolve-config.js";
import { createProject } from "../create-project.js";
import { openStore } from "../storage/sqlite.js";
import type { ContentTypeInput } from "../core/types.js";
import { buildDeletionPlan, isPlanBlocked } from "./plan.js";

interface DocSpec {
  slug: string;
  data: Record<string, unknown>;
  body?: string;
}

/** Build a throwaway project on disk from inline type defs + documents. */
function build(
  types: ContentTypeInput[],
  docs: Record<string, DocSpec[]>,
  opts: { assets?: boolean } = {},
) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-del-"));
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
  return { project: createProject(config), config, rootDir };
}

test("restrict reference blocks the deletion", () => {
  const { project } = build(
    [
      { id: "target", schema: z.object({}) },
      { id: "ref", schema: z.object({ t: field.relation("target") }) },
    ],
    { target: [{ slug: "x", data: {} }], ref: [{ slug: "r", data: { t: "x" } }] },
  );
  const plan = buildDeletionPlan(project, "target", "x");
  assert.equal(isPlanBlocked(plan), true);
  assert.equal(plan.blocked.length, 1);
  assert.deepEqual(plan.blocked[0], {
    typeId: "ref",
    enSlug: "r",
    fieldPath: "t",
    reason: "restrict",
  });
});

test("detach plans array removal and optional-single clear", () => {
  const { project } = build(
    [
      { id: "target", schema: z.object({}) },
      {
        id: "holder",
        schema: z.object({
          many: field.relation("target", { multiple: true, optional: true, onTargetDelete: "detach" }),
          one: field.relation("target", { optional: true, onTargetDelete: "detach" }),
        }),
      },
    ],
    {
      target: [
        { slug: "x", data: {} },
        { slug: "y", data: {} },
      ],
      holder: [{ slug: "h", data: { many: ["x", "y"], one: "x" } }],
    },
  );
  const plan = buildDeletionPlan(project, "target", "x");
  assert.equal(isPlanBlocked(plan), false);
  assert.equal(plan.detaches.length, 2);
  const fields = plan.detaches.map((d) => d.fieldPath).sort();
  assert.deepEqual(fields, ["many", "one"]);
  assert.ok(plan.detaches.every((d) => d.removedSlug === "x" && d.typeId === "holder" && d.enSlug === "h"));
});

test("required single relation blocks even with detach", () => {
  const { project } = build(
    [
      { id: "target", schema: z.object({}) },
      { id: "holder", schema: z.object({ one: field.relation("target", { onTargetDelete: "detach" }) }) },
    ],
    { target: [{ slug: "x", data: {} }], holder: [{ slug: "h", data: { one: "x" } }] },
  );
  const plan = buildDeletionPlan(project, "target", "x");
  assert.equal(isPlanBlocked(plan), true);
  assert.equal(plan.blocked[0]?.reason, "required-single");
});

test("cascade is transitive and drives downstream detaches", () => {
  const { project } = build(
    [
      { id: "model", schema: z.object({}) },
      { id: "example", schema: z.object({ model: field.relation("model", { onTargetDelete: "cascade" }) }) },
      {
        id: "vertical",
        schema: z.object({
          examples: field.relation("example", {
            multiple: true,
            optional: true,
            onTargetDelete: "detach",
          }),
        }),
      },
    ],
    {
      model: [{ slug: "alice", data: {} }],
      example: [{ slug: "ex1", data: { model: "alice" } }],
      vertical: [{ slug: "v1", data: { examples: ["ex1"] } }],
    },
  );
  const plan = buildDeletionPlan(project, "model", "alice");
  assert.equal(isPlanBlocked(plan), false);
  assert.equal(plan.cascades.length, 1);
  assert.equal(plan.cascades[0]?.enSlug, "ex1");
  assert.equal(plan.cascades[0]?.typeId, "example");
  assert.equal(plan.detaches.length, 1);
  assert.deepEqual(
    { typeId: plan.detaches[0]?.typeId, enSlug: plan.detaches[0]?.enSlug, removedSlug: plan.detaches[0]?.removedSlug },
    { typeId: "vertical", enSlug: "v1", removedSlug: "ex1" },
  );
});

test("body relation tokens warn only (never cascade, detach, or block)", () => {
  const { project } = build(
    [
      { id: "target", schema: z.object({}) },
      { id: "post", schema: z.object({}) },
    ],
    {
      target: [{ slug: "x", data: {} }],
      post: [
        // Surviving doc whose body links the deleted target: should warn.
        { slug: "p1", data: {}, body: "See ${{relation:target:x:href}} here." },
        // A doc that references a NON-deleted target: no warning.
        { slug: "p2", data: {}, body: "See ${{relation:post:p1:href}} here." },
      ],
    },
  );
  const plan = buildDeletionPlan(project, "target", "x");
  assert.equal(isPlanBlocked(plan), false);
  assert.equal(plan.cascades.length, 0);
  assert.equal(plan.detaches.length, 0);
  assert.equal(plan.bodyRefWarnings.length, 1);
  assert.deepEqual(plan.bodyRefWarnings[0], {
    typeId: "post",
    enSlug: "p1",
    targetTypeId: "target",
    targetEnSlug: "x",
  });
});

test("cascade cycle terminates (cycle-safe visited set)", () => {
  const { project } = build(
    [
      { id: "a", schema: z.object({ b: field.relation("b", { onTargetDelete: "cascade" }) }) },
      { id: "b", schema: z.object({ a: field.relation("a", { onTargetDelete: "cascade" }) }) },
    ],
    { a: [{ slug: "a1", data: { b: "b1" } }], b: [{ slug: "b1", data: { a: "a1" } }] },
  );
  const plan = buildDeletionPlan(project, "a", "a1");
  assert.equal(plan.cascades.length, 1);
  assert.equal(plan.cascades[0]?.enSlug, "b1");
  assert.equal(plan.blocked.length, 0);
});

test("shared asset kept when referenced outside the set, deleted when only inside", () => {
  const types: ContentTypeInput[] = [
    { id: "album", schema: z.object({}) },
    {
      id: "img",
      schema: z.object({
        album: field.relation("album", { onTargetDelete: "cascade" }),
        file: field.asset({ dir: "/img" }),
      }),
    },
  ];
  const docs = {
    album: [{ slug: "al1", data: {} }],
    img: [
      { slug: "a", data: { album: "al1", file: "/img/shared.webp" } },
      { slug: "b", data: { album: "al1", file: "/img/shared.webp" } },
    ],
  };

  // Deleting one img: the shared path is still referenced by the surviving img.
  const one = buildDeletionPlan(build(types, docs, { assets: true }).project, "img", "a");
  const sharedOne = one.assets.find((x) => x.path === "/img/shared.webp");
  assert.equal(sharedOne?.action, "keep");
  assert.equal(sharedOne?.reason, "shared");

  // Deleting the album cascades both imgs: nothing outside references the path.
  const all = buildDeletionPlan(build(types, docs, { assets: true }).project, "album", "al1");
  const sharedAll = all.assets.filter((x) => x.path === "/img/shared.webp");
  assert.ok(sharedAll.length >= 1);
  assert.ok(sharedAll.every((x) => x.action === "delete"));
});

test("templated asset is deleted with its document", () => {
  const { project } = build(
    [{ id: "thing", schema: z.object({ pic: field.asset({ template: "/t/{slug}.webp" }) }) }],
    { thing: [{ slug: "t1", data: {} }] },
    { assets: true },
  );
  const plan = buildDeletionPlan(project, "thing", "t1");
  const pic = plan.assets.find((a) => a.path === "/t/t1.webp");
  assert.equal(pic?.action, "delete");
});

test("asset onDelete keep leaves the file", () => {
  const { project } = build(
    [
      {
        id: "thing",
        schema: z.object({ pic: field.asset({ template: "/t/{slug}.webp", onDelete: "keep" }) }),
      },
    ],
    { thing: [{ slug: "t1", data: {} }] },
    { assets: true },
  );
  const plan = buildDeletionPlan(project, "thing", "t1");
  const pic = plan.assets.find((a) => a.path === "/t/t1.webp");
  assert.equal(pic?.action, "keep");
  assert.equal(pic?.reason, "config-keep");
});

test("store counts reflect stored rows for deleted docs", () => {
  const { project, config } = build(
    [{ id: "post", schema: z.object({ title: field.translatable(z.string()) }) }],
    { post: [{ slug: "hello", data: { title: "Hello" }, body: "Body." }] },
  );
  const db = openStore(config, "readwrite");
  const snapId = db
    .prepare(
      `INSERT INTO en_snapshots (content_type, en_slug, en_hash, frontmatter_json, body, created_at)
       VALUES ('post','hello','h1','{}','Body.','2026-01-01')`,
    )
    .run().lastInsertRowid as number;
  db.prepare(
    `INSERT INTO translations (content_type, en_slug, locale, slug, frontmatter_json, body, en_hash, translated_at, model, snapshot_id)
     VALUES ('post','hello','fr','bonjour','{}','Corps.','h1','2026-01-01','m', ?)`,
  ).run(snapId);
  db.close();

  const plan = buildDeletionPlan(project, "post", "hello");
  assert.equal(plan.store.length, 1);
  assert.equal(plan.store[0]?.translations, 1);
  assert.equal(plan.store[0]?.snapshots, 1);
});

test("unknown type and missing entry throw", () => {
  const { project } = build([{ id: "post", schema: z.object({}) }], { post: [{ slug: "a", data: {} }] });
  assert.throws(() => buildDeletionPlan(project, "nope", "a"), /Unknown content type/);
  assert.throws(() => buildDeletionPlan(project, "post", "missing"), /No post entry/);
});
