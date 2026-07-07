import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ScribeConfig } from "../src/core/types.js";
import type { AssetRefIndex } from "./introspect-fields.js";
import { renderAssetBrowser } from "./asset-views.js";

function makeFixture(managedDirs: string[]): ScribeConfig {
  const assetsPath = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-asset-views-"));
  fs.mkdirSync(path.join(assetsPath, "imgs/models"), { recursive: true });
  fs.writeFileSync(path.join(assetsPath, "imgs/root.webp"), "x");
  fs.writeFileSync(path.join(assetsPath, "imgs/models/m.webp"), "x");
  return {
    rootDir: assetsPath,
    storePath: path.join(assetsPath, "store.sqlite"),
    assets: { assetsPath, publicPath: "/", managedDirs },
    locales: ["en"],
    defaultLocale: "en",
    localeRouting: { strategy: "path-prefix", prefixDefaultLocale: false },
    types: [],
  } as ScribeConfig;
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("renderAssetBrowser (nested managed roots)", () => {
  it("lists each file under its most specific root only", () => {
    const config = makeFixture(["/imgs", "/imgs/models"]);
    const html = renderAssetBrowser(config, new Map() as AssetRefIndex);

    // Both sections render, and the nested file appears exactly once.
    assert.ok(html.includes(">/imgs <"));
    assert.ok(html.includes(">/imgs/models <"));
    assert.equal(countOccurrences(html, `<span class="apath">/imgs/models/m.webp</span>`), 1);
    assert.equal(countOccurrences(html, `<span class="apath">/imgs/root.webp</span>`), 1);
  });

  it("counts a missing referenced file only in its most specific root", () => {
    const config = makeFixture(["/imgs", "/imgs/models"]);
    const refs: AssetRefIndex = new Map([
      [
        "/imgs/models/ghost.webp",
        [{ typeId: "model", enSlug: "ghost", field: "photo", declared: true }],
      ],
    ]);
    const html = renderAssetBrowser(config, refs);
    assert.equal(countOccurrences(html, `<span class="apath">/imgs/models/ghost.webp</span>`), 1);
  });

  it("drops a parent section fully covered by nested roots", () => {
    const config = makeFixture(["/imgs", "/imgs/models"]);
    fs.rmSync(path.join(assetsDirOf(config), "imgs/root.webp"));
    const html = renderAssetBrowser(config, new Map() as AssetRefIndex);
    assert.ok(!html.includes(">/imgs <"));
    assert.ok(html.includes(">/imgs/models <"));
  });
});

function assetsDirOf(config: ScribeConfig): string {
  return config.assets!.assetsPath;
}
