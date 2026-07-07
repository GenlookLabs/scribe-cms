import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { field } from "../core/field.js";
import type { ContentTypeConfig, ScribeConfig } from "../core/types.js";
import { computePageEnHash } from "../hash/page-hash.js";
import { getTranslatablePayload, readEnDocument } from "../loader/create-loader.js";
import { recordEnSnapshot } from "../history/record-snapshot.js";
import { openStore } from "../storage/sqlite.js";
import { upsertTranslation } from "../storage/translations.js";
import { buildWorklist } from "./worklist.js";

const schema = z.object({
  title: field.translatable(z.string().min(1)),
});

function makeProject(types: ContentTypeConfig[]): ScribeConfig & { tmpDir: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-worklist-"));
  for (const type of types) {
    const dir = path.join(tmpDir, type.contentDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "hello.mdx"),
      `---\ntitle: Hello\n---\n\nBody.`,
      "utf8",
    );
  }
  const config: ScribeConfig = {
    rootDir: tmpDir,
    storePath: path.join(tmpDir, "store.sqlite"),
    locales: ["en", "fr", "de"],
    defaultLocale: "en",
    localeRouting: { strategy: "path-prefix" },
    types,
  };
  openStore(config, "readwrite").close();
  return Object.assign(config, { tmpDir });
}

describe("buildWorklist", () => {
  it("returns nothing for fresh translations unless force is set", () => {
    const vertical: ContentTypeConfig = {
      id: "vertical",
      schema,
      contentDir: "verticals",
      label: "Vertical",
      slugStrategy: "fixed",
      indexFallback: "none",
    };
    const platform: ContentTypeConfig = {
      id: "platform",
      schema,
      contentDir: "platforms",
      label: "Platform",
      slugStrategy: "fixed",
      indexFallback: "none",
    };
    const config = makeProject([vertical, platform]);
    const enDoc = readEnDocument(config, vertical, "hello")!;
    const payload = getTranslatablePayload(enDoc, vertical);
    const hash = computePageEnHash(payload.frontmatter, payload.body);
    const db = openStore(config, "readwrite");
    const snapshotId = recordEnSnapshot(
      config,
      {
        contentType: "vertical",
        enSlug: "hello",
        enHash: hash,
        frontmatter: payload.frontmatter,
        body: payload.body,
      },
      db,
    );
    upsertTranslation(db, {
      contentType: "vertical",
      enSlug: "hello",
      locale: "fr",
      slug: "hello",
      frontmatter: { title: "Bonjour" },
      body: "Corps.",
      enHash: hash,
      translatedAt: new Date().toISOString(),
      model: "test",
      snapshotId,
    });
    db.close();

    const empty = buildWorklist(config, { contentType: "vertical", locales: ["fr"] });
    assert.equal(empty.length, 0);

    const forced = buildWorklist(config, {
      contentType: "vertical",
      locales: ["fr"],
      force: true,
    });
    assert.equal(forced.length, 1);
    assert.equal(forced[0]!.reason, "forced");

    const wrongType = buildWorklist(config, {
      contentType: "platform",
      locales: ["fr"],
      force: true,
    });
    assert.equal(wrongType.length, 1);
    assert.equal(wrongType[0]!.contentType, "platform");
    assert.equal(wrongType[0]!.reason, "missing");
  });

  it("skips bodyless types with no translatable fields but keeps bodyless types that have them", () => {
    const structuralSchema = z.object({
      displayName: field.structural(z.string().min(1)),
    });
    const model: ContentTypeConfig = {
      id: "model",
      schema: structuralSchema,
      contentDir: "models",
      label: "Model",
      slugStrategy: "fixed",
      indexFallback: "none",
      body: false,
    };
    const garment: ContentTypeConfig = {
      id: "garment",
      schema, // translatable `title`
      contentDir: "garments",
      label: "Garment",
      slugStrategy: "fixed",
      indexFallback: "none",
      body: false,
    };
    const config = makeProject([model, garment]);

    const skipped: string[] = [];
    const items = buildWorklist(config, {
      locales: ["fr"],
      onSkipType: (type) => skipped.push(type.id),
    });

    // model: bodyless + no translatable fields → skipped entirely.
    assert.deepEqual(skipped, ["model"]);
    // garment: bodyless but has a translatable field → stays in the worklist.
    assert.deepEqual(
      new Set(items.map((item) => item.contentType)),
      new Set(["garment"]),
    );

    // The bodyless garment payload never carries a body.
    const enDoc = readEnDocument(config, garment, "hello")!;
    const payload = getTranslatablePayload(enDoc, garment);
    assert.equal(payload.body, "");
  });

  it("accepts comma-separated content types", () => {
    const vertical: ContentTypeConfig = {
      id: "vertical",
      schema,
      contentDir: "verticals",
      label: "Vertical",
      slugStrategy: "fixed",
      indexFallback: "none",
    };
    const platform: ContentTypeConfig = {
      id: "platform",
      schema,
      contentDir: "platforms",
      label: "Platform",
      slugStrategy: "fixed",
      indexFallback: "none",
    };
    const config = makeProject([vertical, platform]);

    const items = buildWorklist(config, {
      contentType: "vertical, platform",
      locales: ["fr"],
      force: true,
    });
    assert.equal(items.length, 2);
    assert.deepEqual(
      new Set(items.map((item) => item.contentType)),
      new Set(["vertical", "platform"]),
    );
  });
});
