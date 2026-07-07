import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { field } from "../core/field.js";
import { createScribe } from "../create-scribe.js";
import { createProject } from "../create-project.js";
import { resolveConfig } from "../config/resolve-config.js";
import { openStore } from "../storage/sqlite.js";
import { getOrCreateEnSnapshot, upsertTranslation } from "../storage/translations.js";
import type { ScribeConfigInput } from "../core/types.js";

let tmpDir: string;

function input(): ScribeConfigInput {
  return {
    rootDir: tmpDir,
    locales: ["en", "fr"],
    defaultLocale: "en",
    assets: { dir: "public", publicPath: "/static/" },
    types: [
      {
        id: "blog",
        path: "/blog/{slug}",
        slugStrategy: "localized",
        schema: z.object({ title: field.translatable(z.string()) }),
      },
    ],
  };
}

const HOST_BODY =
  'Link ${{relation:blog:target}} id ${{relation:blog:target:slug}} ' +
  'asset ${{asset:/img/a.webp}} var ${{var:cta}} static ${{static:"Hi"}} esc $\\{{lit}}';

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-inline-"));
  const blogDir = path.join(tmpDir, "content", "blog");
  fs.mkdirSync(blogDir, { recursive: true });
  fs.writeFileSync(path.join(blogDir, "target.mdx"), `---\ntitle: Target\n---\n\nTarget body.`, "utf8");
  fs.writeFileSync(
    path.join(blogDir, "host.mdx"),
    `---\ntitle: Host\nvars:\n  cta: Shop now\n---\n\n${HOST_BODY}`,
    "utf8",
  );

  const config = resolveConfig(input());
  const db = openStore(config, "readwrite");
  const snap = getOrCreateEnSnapshot(db, {
    contentType: "blog",
    enSlug: "host",
    enHash: "h",
    frontmatter: {},
    body: "",
    createdAt: new Date().toISOString(),
  });
  // Localized slug for the target: fr = "cible".
  upsertTranslation(db, {
    contentType: "blog",
    enSlug: "target",
    locale: "fr",
    slug: "cible",
    frontmatter: { title: "Cible" },
    body: "Corps cible.",
    enHash: "h",
    translatedAt: new Date().toISOString(),
    model: "test",
    snapshotId: snap,
  });
  // fr translation for host with the five `%%n%%` markers + an escape.
  upsertTranslation(db, {
    contentType: "blog",
    enSlug: "host",
    locale: "fr",
    slug: "hote",
    frontmatter: { title: "Hôte" },
    body: "Lien %%1%% id %%2%% actif %%3%% var %%4%% statique %%5%% esc $\\{{lit}}",
    enHash: "h",
    translatedAt: new Date().toISOString(),
    model: "test",
    snapshotId: snap,
  });
  db.close();
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("loader inline substitution (gate on: createScribe)", () => {
  it("substitutes tokens in EN bodies in place", () => {
    const scribe = createScribe(input());
    const host = scribe.blog.get("host");
    assert.ok(host);
    assert.equal(
      host!.content,
      "\nLink /blog/target id target asset /static/img/a.webp var Shop now static Hi esc ${{lit}}",
    );
  });

  it("fills %%n%% markers in translated bodies, locale-aware", () => {
    const scribe = createScribe(input());
    const host = scribe.blog.get("hote", "fr");
    assert.ok(host);
    // relation URL uses the fr localized slug (cible) + fr prefix; slug mode is
    // the stable EN slug; var reads the EN vars map; escape decodes.
    assert.equal(
      host!.content,
      "Lien /fr/blog/cible id target actif /static/img/a.webp var Shop now statique Hi esc ${{lit}}",
    );
  });
});

describe("loader inline substitution (gate off: createProject)", () => {
  it("keeps raw token syntax for CLI/validation/studio", () => {
    const project = createProject(resolveConfig(input()));
    const host = project.getType("blog").get("host");
    assert.ok(host);
    assert.equal(host!.content, `\n${HOST_BODY}`);
    // The reserved vars map survives onto EN frontmatter (never a schema field).
    assert.deepEqual((host!.frontmatter as Record<string, unknown>).vars, { cta: "Shop now" });
  });
});
