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
import { getTranslation } from "../storage/translations.js";
import type { ContentTypeInput } from "../core/types.js";
import { buildDeletionPlan } from "./plan.js";
import { executeDeletionPlan } from "./execute.js";

interface DocSpec {
  slug: string;
  data: Record<string, unknown>;
  body?: string;
}

function build(
  types: ContentTypeInput[],
  docs: Record<string, DocSpec[]>,
  opts: { assets?: boolean } = {},
) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-del-exec-"));
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
    locales: ["en", "fr"],
    assets: opts.assets ? { dir: "public" } : undefined,
    types,
  });
  openStore(config, "readwrite").close();
  return { project: createProject(config), config, rootDir };
}

/** Strip the leading YAML frontmatter block, leaving the raw body bytes. */
function bodyOf(raw: string): string {
  return raw.replace(/^﻿?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/, "");
}

function writeAsset(rootDir: string, webPath: string): string {
  const abs = path.join(rootDir, "public", webPath.replace(/^\/+/, ""));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, "x");
  return abs;
}

test("execute removes files, assets, store rows and rewrites detached body untouched", () => {
  const types: ContentTypeInput[] = [
    { id: "model", schema: z.object({ photo: field.asset({ template: "/m/{slug}.webp" }) }) },
    {
      id: "example",
      schema: z.object({
        model: field.relation("model", { onTargetDelete: "cascade" }),
        pic: field.asset({ template: "/e/{slug}.webp" }),
      }),
    },
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
  ];
  const { project, config, rootDir } = build(
    types,
    {
      model: [
        { slug: "alice", data: {} },
        { slug: "bob", data: {} },
      ],
      example: [
        { slug: "ex1", data: { model: "alice" } },
        { slug: "ex2", data: { model: "bob" } },
      ],
      vertical: [{ slug: "v1", data: { examples: ["ex1", "ex2"] }, body: "Intro line.\n\nSecond <Component/> line.\n" }],
    },
    { assets: true },
  );

  const alicePhoto = writeAsset(rootDir, "/m/alice.webp");
  const bobPhoto = writeAsset(rootDir, "/m/bob.webp");
  const ex1Pic = writeAsset(rootDir, "/e/ex1.webp");
  const ex2Pic = writeAsset(rootDir, "/e/ex2.webp");

  // Seed store rows for the docs that will be deleted.
  const db = openStore(config, "readwrite");
  for (const [ct, slug] of [
    ["model", "alice"],
    ["example", "ex1"],
  ] as const) {
    const snapId = db
      .prepare(
        `INSERT INTO en_snapshots (content_type, en_slug, en_hash, frontmatter_json, body, created_at)
         VALUES (?, ?, 'h', '{}', '', '2026-01-01')`,
      )
      .run(ct, slug).lastInsertRowid as number;
    db.prepare(
      `INSERT INTO translations (content_type, en_slug, locale, slug, frontmatter_json, body, en_hash, translated_at, model, snapshot_id)
       VALUES (?, ?, 'fr', ?, '{}', '', 'h', '2026-01-01', 'm', ?)`,
    ).run(ct, slug, slug, snapId);
  }
  db.close();

  const vFile = path.join(rootDir, "content", "vertical", "v1.mdx");
  const originalBody = bodyOf(fs.readFileSync(vFile, "utf8"));

  const plan = buildDeletionPlan(project, "model", "alice");
  const result = executeDeletionPlan(project, plan);

  // EN files: alice + ex1 gone; bob + ex2 survive.
  assert.equal(fs.existsSync(path.join(rootDir, "content", "model", "alice.mdx")), false);
  assert.equal(fs.existsSync(path.join(rootDir, "content", "example", "ex1.mdx")), false);
  assert.equal(fs.existsSync(path.join(rootDir, "content", "model", "bob.mdx")), true);
  assert.equal(fs.existsSync(path.join(rootDir, "content", "example", "ex2.mdx")), true);

  // Asset files: alice + ex1 removed; survivors kept.
  assert.equal(fs.existsSync(alicePhoto), false);
  assert.equal(fs.existsSync(ex1Pic), false);
  assert.equal(fs.existsSync(bobPhoto), true);
  assert.equal(fs.existsSync(ex2Pic), true);

  // Detach: vertical rewritten, body byte-identical, ex1 dropped, ex2 kept.
  const after = fs.readFileSync(vFile, "utf8");
  assert.equal(bodyOf(after), originalBody);
  const data = matter(after).data as { examples: string[] };
  assert.deepEqual(data.examples, ["ex2"]);

  // Store rows for deleted docs removed.
  const db2 = openStore(config, "readonly");
  assert.equal(getTranslation(db2, "model", "alice", "fr"), undefined);
  assert.equal(getTranslation(db2, "example", "ex1", "fr"), undefined);
  const snapCount = db2
    .prepare(`SELECT COUNT(*) c FROM en_snapshots WHERE en_slug IN ('alice','ex1')`)
    .get() as { c: number };
  assert.equal(snapCount.c, 0);
  db2.close();

  assert.equal(result.deletedFiles.length, 2);
  assert.equal(result.deletedAssets.length, 2);
  assert.equal(result.detachedFiles.length, 1);
  assert.equal(result.translationsDeleted, 2);
  assert.equal(result.snapshotsDeleted, 2);
});

test("execute refuses a blocked plan", () => {
  const { project } = build(
    [
      { id: "target", schema: z.object({}) },
      { id: "ref", schema: z.object({ t: field.relation("target") }) },
    ],
    { target: [{ slug: "x", data: {} }], ref: [{ slug: "r", data: { t: "x" } }] },
  );
  const plan = buildDeletionPlan(project, "target", "x");
  assert.throws(() => executeDeletionPlan(project, plan), /blocked/);
});

test("deleted entry vanishes from list() immediately (no dev-revalidation ghost)", () => {
  const { project } = build(
    [{ id: "post", schema: z.object({ title: field.translatable(z.string()) }) }],
    {
      post: [
        { slug: "a", data: { title: "A" } },
        { slug: "b", data: { title: "B" } },
      ],
    },
  );
  const type = project.getType("post");
  assert.deepEqual(
    type.list().map((d) => d.enSlug).sort(),
    ["a", "b"],
  );
  // buildDeletionPlan calls list() (arming the 1500ms dev window); execute must
  // still force a rebuild so the very next list() (well inside the window) is fresh.
  const plan = buildDeletionPlan(project, "post", "a");
  executeDeletionPlan(project, plan);
  assert.deepEqual(
    type.list().map((d) => d.enSlug),
    ["b"],
  );
});
