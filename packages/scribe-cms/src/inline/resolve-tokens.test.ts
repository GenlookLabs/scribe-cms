import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { field } from "../core/field.js";
import { resolveConfig } from "../config/resolve-config.js";
import { openStore } from "../storage/sqlite.js";
import { getOrCreateEnSnapshot, upsertTranslation } from "../storage/translations.js";
import type { ScribeConfigInput } from "../core/types.js";
import { createInlineResolver } from "./resolve-tokens.js";
import { extractInlineTokens } from "./tokens.js";

let tmpDir: string;

function input(): ScribeConfigInput {
  return {
    rootDir: tmpDir,
    locales: ["en", "fr"],
    defaultLocale: "en",
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

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-inline-resolve-"));
  const blogDir = path.join(tmpDir, "content", "blog");
  fs.mkdirSync(blogDir, { recursive: true });
  fs.writeFileSync(path.join(blogDir, "target.mdx"), `---\ntitle: Target\n---\n\nBody.`, "utf8");

  const config = resolveConfig(input());
  const db = openStore(config, "readwrite");
  const snap = getOrCreateEnSnapshot(db, {
    contentType: "blog",
    enSlug: "target",
    enHash: "h",
    frontmatter: {},
    body: "",
    createdAt: new Date().toISOString(),
  });
  upsertTranslation(db, {
    contentType: "blog",
    enSlug: "target",
    locale: "fr",
    slug: "cible",
    frontmatter: { title: "Cible" },
    body: "Corps.",
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

describe("createInlineResolver linkStyle", () => {
  it("resolves :href in app mode to locale-free pathnames", () => {
    const config = resolveConfig(input());
    const resolver = createInlineResolver(config, { linkStyle: "app" });
    const { tokens } = extractInlineTokens("${{relation:blog:target:href}}");
    const token = tokens[0]!;
    assert.equal(resolver.resolve(token, {}, "en"), "/blog/target");
    assert.equal(resolver.resolve(token, {}, "fr"), "/blog/cible");
  });

  it("resolves :href in export mode to localized public paths with extension", () => {
    const config = resolveConfig(input());
    const resolver = createInlineResolver(config, {
      linkStyle: "export",
      exportExtension: ".md",
    });
    const { tokens } = extractInlineTokens("${{relation:blog:target:href}}");
    const token = tokens[0]!;
    assert.equal(resolver.resolve(token, {}, "en"), "/blog/target.md");
    assert.equal(resolver.resolve(token, {}, "fr"), "/fr/blog/cible.md");
  });

  it("resolves :slug to the EN slug in every linkStyle", () => {
    const config = resolveConfig(input());
    const app = createInlineResolver(config, { linkStyle: "app" });
    const exp = createInlineResolver(config, { linkStyle: "export" });
    const { tokens } = extractInlineTokens("${{relation:blog:target:slug}}");
    const token = tokens[0]!;
    assert.equal(app.resolve(token, {}, "fr"), "target");
    assert.equal(exp.resolve(token, {}, "fr"), "target");
  });
});
