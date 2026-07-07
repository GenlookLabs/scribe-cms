import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { contentTypeForPath, resolveAssetWebPath, serveStudioAsset } from "./asset-serve.js";
import type { ScribeConfig } from "../src/core/types.js";

const ASSETS = "/tmp/scribe-studio-assets";

function configWithAssets(assetsPath: string | undefined): ScribeConfig {
  return {
    rootDir: "/tmp/content",
    storePath: "/tmp/store.sqlite",
    assetsPath,
    assets: assetsPath
      ? { assetsPath, publicPath: "/", managedDirs: [] }
      : undefined,
    locales: ["en"],
    defaultLocale: "en",
    localeRouting: { strategy: "path-prefix", prefixDefaultLocale: false },
    localeFallbacks: {},
    types: [],
  } as ScribeConfig;
}

describe("resolveAssetWebPath (traversal safety)", () => {
  const config = configWithAssets(ASSETS);

  it("resolves a normal web path inside the assets dir", () => {
    const r = resolveAssetWebPath(config, "/try-on/model.webp");
    assert.ok(r);
    assert.equal(r!.absPath, path.join(ASSETS, "try-on/model.webp"));
  });

  it("accepts a path without a leading slash", () => {
    const r = resolveAssetWebPath(config, "img/a.png");
    assert.ok(r);
    assert.equal(r!.absPath, path.join(ASSETS, "img/a.png"));
  });

  it("rejects ../ traversal escaping the assets dir", () => {
    assert.equal(resolveAssetWebPath(config, "/../../etc/passwd"), null);
    assert.equal(resolveAssetWebPath(config, "../../etc/passwd"), null);
    assert.equal(resolveAssetWebPath(config, "/a/../../etc/passwd"), null);
  });

  it("rejects deep traversal that resolves outside even with valid prefix", () => {
    assert.equal(resolveAssetWebPath(config, "/try-on/../../../etc/passwd"), null);
  });

  it("collapses internal ../ that stays inside the dir", () => {
    const r = resolveAssetWebPath(config, "/a/b/../c.webp");
    assert.ok(r);
    assert.equal(r!.absPath, path.join(ASSETS, "a/c.webp"));
  });

  it("rejects NUL bytes", () => {
    assert.equal(resolveAssetWebPath(config, "/img/a.png\0.txt"), null);
  });

  it("rejects empty / non-string paths", () => {
    assert.equal(resolveAssetWebPath(config, ""), null);
    // @ts-expect-error deliberately wrong type
    assert.equal(resolveAssetWebPath(config, undefined), null);
  });

  it("returns null when the asset system is disabled", () => {
    assert.equal(resolveAssetWebPath(configWithAssets(undefined), "/a.png"), null);
  });

  it("allows the assets root itself", () => {
    const r = resolveAssetWebPath(config, "/");
    assert.ok(r);
    assert.equal(r!.absPath, path.resolve(ASSETS));
  });

  it("does not treat a sibling dir with a shared prefix as inside", () => {
    // /tmp/scribe-studio-assets-evil must not count as inside /tmp/scribe-studio-assets
    const r = resolveAssetWebPath(config, "/../scribe-studio-assets-evil/x.png");
    assert.equal(r, null);
  });
});

describe("serveStudioAsset", () => {
  it("returns video/mp4 for .mp4 paths", () => {
    assert.equal(contentTypeForPath("/clips/intro.mp4"), "video/mp4");
  });

  it("returns body bytes and content type for an existing file", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-asset-serve-"));
    const assetsDir = path.join(root, "assets");
    fs.mkdirSync(assetsDir);
    fs.writeFileSync(path.join(assetsDir, "a.webp"), "RIFF----WEBPVP8 ");
    const config = configWithAssets(assetsDir);
    const result = serveStudioAsset(config, "/a.webp");
    assert.ok(result);
    assert.equal(result!.contentType, "image/webp");
    assert.ok(result!.body.length > 0);
  });

  it("returns null for a missing file", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-asset-serve-"));
    const assetsDir = path.join(root, "assets");
    fs.mkdirSync(assetsDir);
    const config = configWithAssets(assetsDir);
    assert.equal(serveStudioAsset(config, "/missing.webp"), null);
  });

  it("returns null for a traversal path that escapes the assets dir", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-asset-serve-"));
    const assetsDir = path.join(root, "assets");
    fs.mkdirSync(assetsDir);
    fs.writeFileSync(path.join(root, "secret"), "nope");
    const config = configWithAssets(assetsDir);
    assert.equal(serveStudioAsset(config, "/../secret"), null);
  });
});
