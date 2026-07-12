import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import { field } from "./field.js";
import { resolveConfig } from "../config/resolve-config.js";
import { getManagedRoots, templateManagedRoot } from "./managed-roots.js";

describe("templateManagedRoot", () => {
  it("drops the trailing partial segment after the last slash", () => {
    assert.equal(templateManagedRoot("/try-on/garments/{slug}/product.webp"), "/try-on/garments");
  });

  it("handles a template with the brace directly in a segment", () => {
    assert.equal(templateManagedRoot("/g/{slug}.webp"), "/g");
  });
});

describe("getManagedRoots", () => {
  it("returns an empty array when the asset system is disabled", () => {
    const config = resolveConfig({
      rootDir: "/proj",
      locales: ["en"],
      types: [{ id: "garment", schema: z.object({ img: field.asset({ dir: "/g" }) }) }],
    });
    assert.deepEqual(getManagedRoots(config), []);
  });

  it("unions managedDirs with field dirs and template prefixes, deduped and sorted", () => {
    const config = resolveConfig({
      rootDir: "/proj",
      locales: ["en"],
      assets: { managedDirs: ["/blog-images", "/g"] },
      types: [
        {
          id: "garment",
          schema: z.object({
            productImage: field.asset({ dir: "/g" }),
            hero: field.asset({ template: "/try-on/garments/{slug}/product.webp" }),
          }),
        },
      ],
    });
    assert.deepEqual(getManagedRoots(config), ["/blog-images", "/g", "/try-on/garments"]);
  });

  it("a multiple field's dir participates like a single field's", () => {
    const config = resolveConfig({
      rootDir: "/proj",
      locales: ["en"],
      assets: {},
      types: [
        {
          id: "album",
          schema: z.object({ images: field.asset({ dir: "/gallery", multiple: true }) }),
        },
      ],
    });
    assert.deepEqual(getManagedRoots(config), ["/gallery"]);
  });
});
