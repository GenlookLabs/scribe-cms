import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { field } from "./core/field.js";
import { createScribe } from "./create-scribe.js";
import { resolveConfig } from "./config/resolve-config.js";
import { openStore } from "./storage/sqlite.js";
import type { ScribeConfigInput } from "./core/types.js";

let tmpDir: string;

function baseInput(assets?: ScribeConfigInput["assets"]): ScribeConfigInput {
  return {
    rootDir: tmpDir,
    locales: ["en"],
    assets,
    types: [
      {
        id: "garment",
        schema: z.object({ title: field.translatable(z.string()) }),
      },
    ],
  };
}

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-create-"));
  const contentDir = path.join(tmpDir, "content", "garment");
  fs.mkdirSync(contentDir, { recursive: true });
  fs.writeFileSync(path.join(contentDir, "denim.mdx"), `---\ntitle: Denim\n---\n\nBody.`, "utf8");
  // Precreate the store so the loader can open it read-only.
  openStore(resolveConfig(baseInput({})), "readwrite").close();
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("scribe.assets.url", () => {
  it("applies a relative publicPath prefix", () => {
    const scribe = createScribe(baseInput({ publicPath: "/static/" }));
    assert.equal(scribe.assets.url("/g/hero.webp"), "/static/g/hero.webp");
  });

  it("passes through when publicPath is / (default)", () => {
    const scribe = createScribe(baseInput({}));
    assert.equal(scribe.assets.url("/g/hero.webp"), "/g/hero.webp");
  });

  it("returns the ref unchanged when the asset system is disabled", () => {
    const scribe = createScribe(baseInput());
    assert.equal(scribe.assets.url("/g/hero.webp"), "/g/hero.webp");
  });

  it("throws on reserved (unknown) options", () => {
    const scribe = createScribe(baseInput({ publicPath: "/static" }));
    assert.throws(
      () => scribe.assets.url("/g/hero.webp", { width: 800 } as never),
      /reserved for a future pipeline/,
    );
  });
});
