import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { field } from "../core/field.js";
import { listAssetFields } from "../core/introspect-schema.js";
import { resolveConfig } from "../config/resolve-config.js";
import { createProject } from "../create-project.js";
import type { ResolvedAssetsConfig, ScribeDocument } from "../core/types.js";
import { computePageEnHash } from "../hash/page-hash.js";
import { recordEnSnapshot } from "../history/record-snapshot.js";
import { openStore } from "../storage/sqlite.js";
import { upsertTranslation } from "../storage/translations.js";
import { getTranslatablePayload } from "./create-loader.js";
import { joinPublicPath, resolveDocumentAssets } from "./resolve-assets.js";

describe("joinPublicPath", () => {
  it("passes through when publicPath is / or empty", () => {
    assert.equal(joinPublicPath("/", "/a.webp"), "/a.webp");
    assert.equal(joinPublicPath("", "/a.webp"), "/a.webp");
  });

  it("prefixes a relative path root, avoiding double slashes", () => {
    assert.equal(joinPublicPath("/static/", "/a.webp"), "/static/a.webp");
    assert.equal(joinPublicPath("/static", "/a.webp"), "/static/a.webp");
  });

  it("prefixes an absolute origin, stripping the trailing slash", () => {
    assert.equal(
      joinPublicPath("https://cdn.example.com/", "/try-on/a.webp"),
      "https://cdn.example.com/try-on/a.webp",
    );
    assert.equal(joinPublicPath("https://cdn.example.com", "/a.webp"), "https://cdn.example.com/a.webp");
  });
});

function makeDoc(frontmatter: Record<string, unknown>, enSlug = "denim"): ScribeDocument {
  return {
    slug: enSlug,
    enSlug,
    locale: "en",
    noindex: false,
    frontmatter,
    content: "",
  };
}

const rootAssets: ResolvedAssetsConfig = { assetsPath: "/x", publicPath: "/", managedDirs: [] };
const cdnAssets: ResolvedAssetsConfig = {
  assetsPath: "/x",
  publicPath: "https://cdn.example.com/",
  managedDirs: [],
};

describe("resolveDocumentAssets", () => {
  const schema = z.object({
    productImage: field.asset({ dir: "/g" }),
    hero: field.asset({ template: "/g/{slug}/product.webp" }),
    gallery: z.array(z.object({ src: field.asset() })),
  });
  const fields = listAssetFields(schema);

  it("prefixes present values and materializes templates", () => {
    const doc = makeDoc({
      productImage: "/g/denim.webp",
      gallery: [{ src: "/g/a.webp" }, { src: "/g/b.webp" }],
    });
    resolveDocumentAssets(doc, fields, rootAssets);
    const fm = doc.frontmatter as Record<string, unknown>;
    assert.equal(fm.productImage, "/g/denim.webp");
    assert.equal(fm.hero, "/g/denim/product.webp");
    assert.deepEqual(fm.gallery, [{ src: "/g/a.webp" }, { src: "/g/b.webp" }]);
  });

  it("applies an absolute-origin publicPath", () => {
    const doc = makeDoc({ productImage: "/g/denim.webp", gallery: [] });
    resolveDocumentAssets(doc, fields, cdnAssets);
    const fm = doc.frontmatter as Record<string, unknown>;
    assert.equal(fm.productImage, "https://cdn.example.com/g/denim.webp");
    assert.equal(fm.hero, "https://cdn.example.com/g/denim/product.webp");
  });

  it("an explicit value overrides the template", () => {
    const doc = makeDoc({ productImage: "/g/x.webp", hero: "/g/shared.webp", gallery: [] });
    resolveDocumentAssets(doc, fields, rootAssets);
    assert.equal((doc.frontmatter as Record<string, unknown>).hero, "/g/shared.webp");
  });

  it("leaves an absent optional non-template field undefined", () => {
    const optSchema = z.object({ maybe: field.asset({ optional: true }) });
    const doc = makeDoc({});
    resolveDocumentAssets(doc, listAssetFields(optSchema), rootAssets);
    assert.equal((doc.frontmatter as Record<string, unknown>).maybe, undefined);
  });
});

describe("loader integration: resolveAssets flag", () => {
  function makeProject(locales = ["en"]): { tmpDir: string; config: ReturnType<typeof resolveConfig> } {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-assets-"));
    const contentDir = path.join(tmpDir, "content", "garment");
    fs.mkdirSync(contentDir, { recursive: true });
    fs.writeFileSync(
      path.join(contentDir, "denim.mdx"),
      `---\ntitle: Denim\nproductImage: /g/denim.webp\n---\n\nBody.`,
      "utf8",
    );
    const config = resolveConfig({
      rootDir: tmpDir,
      locales,
      assets: { publicPath: "/static" },
      types: [
        {
          id: "garment",
          schema: z.object({
            title: field.translatable(z.string()),
            productImage: field.asset({ dir: "/g" }),
            hero: field.asset({ template: "/g/{slug}/product.webp" }),
          }),
        },
      ],
    });
    openStore(config, "readwrite").close();
    return { tmpDir, config };
  }

  it("resolves asset values only when resolveAssets is set; source values otherwise", () => {
    const { tmpDir, config } = makeProject();
    try {
      const source = createProject(config).getType("garment").get("denim");
      const resolved = createProject(config, { resolveAssets: true }).getType("garment").get("denim");

      const sourceFm = source!.frontmatter as Record<string, unknown>;
      const resolvedFm = resolved!.frontmatter as Record<string, unknown>;

      // Non-resolving project (export/translate path) sees raw source values.
      assert.equal(sourceFm.productImage, "/g/denim.webp");
      assert.equal(sourceFm.hero, undefined);

      // Resolving project (createScribe path) applies publicPath + materializes template.
      assert.equal(resolvedFm.productImage, "/static/g/denim.webp");
      assert.equal(resolvedFm.hero, "/static/g/denim/product.webp");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("locale documents get resolved values from the merged EN source", () => {
    const { tmpDir, config } = makeProject(["en", "fr"]);
    try {
      const type = config.types[0]!;
      const enDoc = createProject(config).getType("garment").get("denim")!;
      const payload = getTranslatablePayload(enDoc, type);
      const hash = computePageEnHash(payload.frontmatter, payload.body);
      const db = openStore(config, "readwrite");
      const snapshotId = recordEnSnapshot(
        config,
        { contentType: "garment", enSlug: "denim", enHash: hash, frontmatter: payload.frontmatter, body: payload.body },
        db,
      );
      upsertTranslation(db, {
        contentType: "garment",
        enSlug: "denim",
        locale: "fr",
        slug: "denim",
        frontmatter: { title: "Denim FR" },
        body: "Corps.",
        enHash: hash,
        translatedAt: new Date().toISOString(),
        model: "test",
        snapshotId,
      });
      db.close();

      const frResolved = createProject(config, { resolveAssets: true })
        .getType("garment")
        .get("denim", "fr")!;
      const frFm = frResolved.frontmatter as Record<string, unknown>;
      assert.equal(frFm.title, "Denim FR");
      assert.equal(frFm.productImage, "/static/g/denim.webp");
      assert.equal(frFm.hero, "/static/g/denim/product.webp");

      // The non-resolving project keeps source values on the locale doc too.
      const frSource = createProject(config).getType("garment").get("denim", "fr")!;
      assert.equal((frSource.frontmatter as Record<string, unknown>).productImage, "/g/denim.webp");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
