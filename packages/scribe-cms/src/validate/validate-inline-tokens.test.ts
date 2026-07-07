import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { field } from "../core/field.js";
import { resolveConfig } from "../config/resolve-config.js";
import { openStore } from "../storage/sqlite.js";
import { validateProject } from "./validate-project.js";
import type { ScribeConfigInput, ScribeConfig } from "../core/types.js";
import type { ValidateIssue } from "./validate-project.js";

let tmpDir: string;
let config: ScribeConfig;

function input(): ScribeConfigInput {
  return {
    rootDir: tmpDir,
    locales: ["en"],
    defaultLocale: "en",
    assets: { dir: "public", publicPath: "/static/" },
    types: [
      {
        id: "blog",
        path: "/blog/{slug}",
        translate: { context: "x" },
        schema: z.object({ title: field.translatable(z.string()) }),
      },
      {
        id: "ref",
        // No `path`: not routable — url-mode relations to it are errors.
        schema: z.object({ name: field.translatable(z.string()) }),
      },
    ],
  };
}

function write(rel: string, body: string): void {
  const file = path.join(tmpDir, "content", rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, "utf8");
}

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-inline-val-"));
  fs.mkdirSync(path.join(tmpDir, "public", "img"), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, "public", "img", "a.webp"), "x", "utf8");

  write("blog/target.mdx", `---\ntitle: Target\n---\n\nBody.`);
  write("ref/refonly.mdx", `---\nname: Ref\n---\n\nBody.`);

  write(
    "blog/good.mdx",
    `---\ntitle: Good\nvars:\n  k: v\n---\n\n` +
      'Rel ${{relation:blog:target}} slug ${{relation:ref:refonly:slug}} ' +
      'asset ${{asset:/img/a.webp}} var ${{var:k}} static ${{static:"x"}}',
  );

  write(
    "blog/bad.mdx",
    `---\ntitle: Bad\n---\n\n` +
      'a ${{relation:blog:missing}} b ${{relation:nope:x}} c ${{relation:ref:refonly}} ' +
      'd ${{asset:/img/missing.webp}} e ${{var:absent}} f ${{static:oops}}',
  );

  write("blog/badvars.mdx", `---\ntitle: BadVars\nvars: notarecord\n---\n\n\${{var:x}}`);

  config = resolveConfig(input());
  openStore(config, "readwrite").close();
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function errorsFor(issues: ValidateIssue[], enSlug: string): ValidateIssue[] {
  return issues.filter((i) => i.enSlug === enSlug && i.level === "error");
}

function hasMessage(issues: ValidateIssue[], re: RegExp): boolean {
  return issues.some((i) => re.test(i.message));
}

describe("validateInlineTokens", () => {
  it("reports no inline-token errors for a valid document", () => {
    const { issues } = validateProject(config);
    const goodErrors = errorsFor(issues, "good").filter((i) =>
      /inline|token|vars/i.test(i.message),
    );
    assert.deepEqual(goodErrors, [], JSON.stringify(goodErrors));
    // Valid tokens must not surface as false MDX errors.
    assert.equal(hasMessage(errorsFor(issues, "good"), /Invalid MDX/), false);
  });

  it("flags each malformed / dangling token kind", () => {
    const { issues } = validateProject(config);
    const bad = errorsFor(issues, "bad");
    assert.ok(hasMessage(bad, /no blog doc has that slug/), "unknown enSlug");
    assert.ok(hasMessage(bad, /unknown type "nope"/), "unknown type");
    assert.ok(hasMessage(bad, /not routable/), "url mode on non-routable target");
    assert.ok(hasMessage(bad, /missing on disk/), "missing asset file");
    assert.ok(hasMessage(bad, /absent from this document's vars map/), "missing var key");
    assert.ok(hasMessage(bad, /Malformed inline token/), "malformed static");
  });

  it("flags a malformed vars map", () => {
    const { issues } = validateProject(config);
    assert.ok(hasMessage(errorsFor(issues, "badvars"), /vars.*string-to-string map/));
  });

  it("marks the whole project invalid", () => {
    assert.equal(validateProject(config).ok, false);
  });
});
