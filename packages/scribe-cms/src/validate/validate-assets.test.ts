import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { field } from "../core/field.js";
import { resolveConfig } from "../config/resolve-config.js";
import type { ScribeConfig } from "../core/types.js";
import { validateDeclaredAssetFields } from "./validate-assets.js";

let tmpDir: string;
let config: ScribeConfig;

const schema = z.object({
  productImage: field.asset({ dir: "/g", formats: ["webp"], maxKB: 1 }),
  hero: field.asset({ template: "/g/{slug}/product.webp" }),
  logo: field.asset({ optional: true }),
});

function writeAsset(webPath: string, bytes: number): void {
  const abs = path.join(tmpDir, "public", webPath.replace(/^\//, ""));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, Buffer.alloc(bytes, 0));
}

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-validate-assets-"));
  fs.mkdirSync(path.join(tmpDir, "public"), { recursive: true });
  writeAsset("/g/denim.webp", 100);
  writeAsset("/g/denim/product.webp", 100);
  writeAsset("/g/heavy.webp", 4096);
  writeAsset("/g/wrong.png", 100);
  config = resolveConfig({
    rootDir: tmpDir,
    locales: ["en"],
    assets: {},
    types: [{ id: "garment", schema }],
  });
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function run(frontmatter: Record<string, unknown>, enSlug = "denim") {
  return validateDeclaredAssetFields(config, {
    contentType: "garment",
    enSlug,
    frontmatter,
    schema,
  });
}

describe("validateDeclaredAssetFields", () => {
  it("passes when required present, template file exists, within dir/formats/size", () => {
    const issues = run({ productImage: "/g/denim.webp" });
    assert.deepEqual(issues, []);
  });

  it("required field absent is an error with attribution", () => {
    const issues = run({}); // productImage missing (required, no template)
    const err = issues.find((i) => i.field === "productImage");
    assert.equal(err?.level, "error");
    assert.match(err!.message, /garment\/denim: productImage is required but missing/);
  });

  it("present value with missing file is an error", () => {
    const issues = run({ productImage: "/g/nope.webp" });
    const err = issues.find((i) => i.field === "productImage");
    assert.equal(err?.level, "error");
    assert.match(err!.message, /productImage → \/g\/nope\.webp not found/);
  });

  it("value outside declared dir is an error", () => {
    writeAsset("/other/x.webp", 100);
    const issues = run({ productImage: "/other/x.webp" });
    const err = issues.find((i) => i.message.includes("outside declared dir"));
    assert.equal(err?.level, "error");
  });

  it("extension not in formats is a warning", () => {
    const issues = run({ productImage: "/g/wrong.png" });
    const warn = issues.find((i) => i.message.includes("not in formats"));
    assert.equal(warn?.level, "warning");
  });

  it("file over maxKB is a warning", () => {
    const issues = run({ productImage: "/g/heavy.webp" });
    const warn = issues.find((i) => i.message.includes("budget"));
    assert.equal(warn?.level, "warning");
  });

  it("templated field validates the materialized path (error when missing)", () => {
    const issues = run({ productImage: "/g/denim.webp" }, "ghost");
    const err = issues.find((i) => i.field === "hero");
    assert.equal(err?.level, "error");
    assert.match(err!.message, /hero → \/g\/ghost\/product\.webp not found/);
  });

  it("optional absent field produces no issue", () => {
    const issues = run({ productImage: "/g/denim.webp" });
    assert.equal(issues.some((i) => i.field === "logo"), false);
  });

  it("returns nothing when the asset system is disabled", () => {
    const noAssets = resolveConfig({ rootDir: tmpDir, locales: ["en"], types: [{ id: "garment", schema }] });
    const issues = validateDeclaredAssetFields(noAssets, {
      contentType: "garment",
      enSlug: "denim",
      frontmatter: {},
      schema,
    });
    assert.deepEqual(issues, []);
  });
});

describe("validateDeclaredAssetFields — multiple fields", () => {
  const multiSchema = z.object({
    images: field.asset({ dir: "/g", formats: ["webp"], maxKB: 1, multiple: true, min: 1, max: 2 }),
  });
  const runMulti = (frontmatter: Record<string, unknown>) =>
    validateDeclaredAssetFields(config, {
      contentType: "garment",
      enSlug: "denim",
      frontmatter,
      schema: multiSchema,
    });

  it("passes when every element exists within dir/formats/size and count is in range", () => {
    assert.deepEqual(runMulti({ images: ["/g/denim.webp"] }), []);
  });

  it("required-but-empty error for an empty array", () => {
    const err = runMulti({ images: [] }).find((i) => i.field === "images");
    assert.equal(err?.level, "error");
    assert.match(err!.message, /images is required but empty/);
  });

  it("required-but-empty error when the field is absent", () => {
    const err = runMulti({}).find((i) => i.field === "images");
    assert.equal(err?.level, "error");
    assert.match(err!.message, /images is required but empty/);
  });

  it("count over max is an error", () => {
    const err = runMulti({ images: ["/g/denim.webp", "/g/denim.webp", "/g/denim.webp"] }).find(
      (i) => i.message.includes("more than the maximum"),
    );
    assert.equal(err?.level, "error");
    assert.match(err!.message, /has 3 item\(s\), more than the maximum 2/);
  });

  it("per-element missing file is reported with an indexed field path", () => {
    const issues = runMulti({ images: ["/g/denim.webp", "/g/nope.webp"] });
    const err = issues.find((i) => i.field === "images.1");
    assert.equal(err?.level, "error");
    assert.match(err!.message, /images\.1 → \/g\/nope\.webp not found/);
  });

  it("per-element format and size violations are warnings", () => {
    const issues = runMulti({ images: ["/g/wrong.png", "/g/heavy.webp"] });
    assert.equal(issues.find((i) => i.field === "images.0" && i.level === "warning")?.message.includes("not in formats"), true);
    assert.equal(issues.find((i) => i.field === "images.1" && i.level === "warning")?.message.includes("budget"), true);
  });

  it("optional multiple absent produces no issue", () => {
    const optSchema = z.object({ images: field.asset({ dir: "/g", multiple: true, optional: true }) });
    const issues = validateDeclaredAssetFields(config, {
      contentType: "garment",
      enSlug: "denim",
      frontmatter: {},
      schema: optSchema,
    });
    assert.deepEqual(issues, []);
  });
});
