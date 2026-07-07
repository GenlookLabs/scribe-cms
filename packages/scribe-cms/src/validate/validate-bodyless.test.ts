import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { field } from "../core/field.js";
import { resolveConfig } from "../config/resolve-config.js";
import type { ScribeConfig } from "../core/types.js";
import { openStore } from "../storage/sqlite.js";
import { validateProject } from "./validate-project.js";

let tmpDir: string;
let config: ScribeConfig;

const modelSchema = z.object({
  displayName: field.structural(z.string().min(1)),
});

function writeModel(slug: string, body: string): void {
  const dir = path.join(tmpDir, "content", "models");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${slug}.md`),
    `---\ndisplayName: ${slug}\n---\n${body}`,
    "utf8",
  );
}

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-validate-bodyless-"));
  writeModel("clean", "\n");
  writeModel("stray", "\nThis body should not exist.\n");
  config = resolveConfig({
    rootDir: tmpDir,
    locales: ["en", "fr"],
    types: [{ id: "model", contentDir: "models", schema: modelSchema, body: false }],
  });
  openStore(config, "readwrite").close();
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("validateProject — bodyless types", () => {
  it("errors on a non-empty body for a body: false entry, with attribution", () => {
    const result = validateProject(config);
    const err = result.issues.find(
      (i) => i.enSlug === "stray" && i.field === "body",
    );
    assert.equal(err?.level, "error");
    assert.equal(err?.contentType, "model");
    assert.match(
      err!.message,
      /type "model" is frontmatter-only \(body: false\) but the entry has body content/,
    );
    assert.equal(result.ok, false);
  });

  it("does not flag a frontmatter-only entry (whitespace body is fine)", () => {
    const result = validateProject(config);
    const cleanIssue = result.issues.find(
      (i) => i.enSlug === "clean" && i.field === "body",
    );
    assert.equal(cleanIssue, undefined);
  });
});
