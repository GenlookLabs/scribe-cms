import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { field } from "../core/field.js";
import { createScribe } from "../create-scribe.js";
import { resolveConfig } from "../config/resolve-config.js";
import { openStore } from "../storage/sqlite.js";
import { getOrCreateEnSnapshot, upsertTranslation } from "../storage/translations.js";
import type { ScribeConfigInput } from "../core/types.js";
import { buildWorklist } from "../translate/worklist.js";

let tmpDir: string;

function input(): ScribeConfigInput {
  return {
    rootDir: tmpDir,
    locales: ["en", "fr"],
    defaultLocale: "en",
    types: [
      {
        id: "legal",
        path: "/legal/{slug}",
        translatable: false,
        schema: z.object({ title: field.structural(z.string()) }),
      },
    ],
  };
}

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-translatable-opt-out-"));
  const dir = path.join(tmpDir, "content", "legal");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "terms.mdx"), `---\ntitle: Terms\n---\n\nEnglish body.`, "utf8");

  // A translation left over from before the type opted out.
  const config = resolveConfig(input());
  const db = openStore(config, "readwrite");
  const snap = getOrCreateEnSnapshot(db, {
    contentType: "legal",
    enSlug: "terms",
    enHash: "old",
    frontmatter: {},
    body: "",
    createdAt: new Date().toISOString(),
  });
  upsertTranslation(db, {
    contentType: "legal",
    enSlug: "terms",
    locale: "fr",
    slug: "terms",
    frontmatter: {},
    body: "Corps traduit.",
    enHash: "old",
    translatedAt: new Date().toISOString(),
    model: "test",
    snapshotId: snap,
  });
  db.close();
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("translatable: false", () => {
  it("queues nothing, even with a stale stored translation", () => {
    const config = resolveConfig(input());
    assert.equal(buildWorklist(config, { locales: ["fr"], force: true }).length, 0);
  });

  it("serves the English document on locale routes and ignores stored rows", () => {
    const scribe = createScribe(input()) as unknown as Record<
      string,
      { resolve: (slug: string, locale: string) => { document?: { content: string } | null } }
    >;
    const resolved = scribe.legal!.resolve("terms", "fr");
    assert.match(resolved.document?.content ?? "", /English body\./);
  });
});
