import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import { field } from "./field.js";
import { isTypeTranslatable, listTranslatableFields } from "./introspect-schema.js";

const translatableSchema = z.object({
  title: field.translatable(z.string().min(1)),
  gender: field.structural(z.enum(["female", "male"])),
});

const structuralOnlySchema = z.object({
  displayName: field.structural(z.string().min(1)),
  gender: field.structural(z.enum(["female", "male"])),
});

describe("listTranslatableFields", () => {
  it("returns only the translatable-marked fields", () => {
    const fields = listTranslatableFields(translatableSchema);
    assert.deepEqual(
      fields.map((f) => f.path.join(".")),
      ["title"],
    );
  });

  it("returns an empty list for a structural-only schema", () => {
    assert.equal(listTranslatableFields(structuralOnlySchema).length, 0);
  });
});

describe("isTypeTranslatable", () => {
  it("bodyless + no translatable fields → false", () => {
    assert.equal(
      isTypeTranslatable({ schema: structuralOnlySchema, body: false }),
      false,
    );
  });

  it("bodyless + a translatable field → true", () => {
    assert.equal(
      isTypeTranslatable({ schema: translatableSchema, body: false }),
      true,
    );
  });

  it("body default (undefined) → true even with no translatable fields", () => {
    assert.equal(isTypeTranslatable({ schema: structuralOnlySchema }), true);
  });

  it("body: true → true even with no translatable fields", () => {
    assert.equal(
      isTypeTranslatable({ schema: structuralOnlySchema, body: true }),
      true,
    );
  });
});
