import { z } from "zod";
import { getFieldKind, peelOptionalWrappers } from "../core/field.js";
import type { SlugStrategy } from "../core/types.js";

function getObjectShape(schema: z.ZodTypeAny): z.ZodRawShape | null {
  const base = peelOptionalWrappers(schema);
  if (base instanceof Object && "shape" in base) {
    return (base as z.ZodObject<z.ZodRawShape>).shape;
  }
  return null;
}

function getArraySchema(schema: z.ZodTypeAny): z.ZodArray | null {
  const base = peelOptionalWrappers(schema);
  if (
    base instanceof Object &&
    "element" in base &&
    (base as z.ZodTypeAny & { _def?: { type?: string } })._def?.type === "array"
  ) {
    return base as z.ZodArray;
  }
  return null;
}

function extractTranslatableFromStructural(schema: z.ZodTypeAny): z.ZodTypeAny | null {
  const arraySchema = getArraySchema(schema);
  if (arraySchema) {
    const inner = buildTranslatableSubschema(arraySchema.element as z.ZodTypeAny);
    if (inner) return z.array(inner);
    return null;
  }
  if (getObjectShape(schema)) {
    return buildTranslatableSubschema(schema);
  }
  return null;
}

/** Build a Zod object schema containing only translatable fields (including nested in structural arrays). */
export function buildTranslatableSubschema(schema: z.ZodTypeAny): z.ZodObject | null {
  const shape = getObjectShape(schema);
  if (!shape) return null;

  const out: Record<string, z.ZodTypeAny> = {};
  for (const [key, child] of Object.entries(shape)) {
    const childSchema = child as z.ZodTypeAny;
    const kind = getFieldKind(childSchema);
    if (kind === "translatable") {
      out[key] = peelOptionalWrappers(childSchema);
    } else if (kind === "structural") {
      const nested = extractTranslatableFromStructural(childSchema);
      if (nested) out[key] = nested;
    }
  }

  if (Object.keys(out).length === 0) return null;
  return z.object(out);
}

/**
 * Like `buildTranslatableSubschema`, but only includes keys present in the EN
 * translatable payload. Prevents the model from hallucinating nested structural
 * arrays (e.g. blog `itemList`) when the source document has none.
 */
export function buildTranslatableSubschemaForPayload(
  schema: z.ZodTypeAny,
  translatableFrontmatter: Record<string, unknown>,
): z.ZodObject | null {
  const full = buildTranslatableSubschema(schema);
  if (!full) return null;

  const filtered: Record<string, z.ZodTypeAny> = {};
  for (const [key, childSchema] of Object.entries(full.shape)) {
    if (!(key in translatableFrontmatter)) continue;
    const value = translatableFrontmatter[key];
    if (value === undefined || value === null) continue;
    filtered[key] = childSchema as z.ZodTypeAny;
  }

  if (Object.keys(filtered).length === 0) return null;
  return z.object(filtered);
}

/**
 * JSON Schema for Gemini structured output: `{ frontmatter, body, slug? }`.
 * Types without translatable frontmatter get a body-only schema (Gemini
 * rejects OBJECT schemas with empty `properties`); parsing then defaults the
 * missing frontmatter to `{}`. Skipping the schema entirely instead would
 * leave the model free-handing JSON, which fails often on MDX bodies
 * (unescaped newlines, trailing prose after the JSON).
 */
export function buildGeminiResponseSchema(
  schema: z.ZodTypeAny,
  slugStrategy: SlugStrategy,
  translatableFrontmatter?: Record<string, unknown>,
): Record<string, unknown> | null {
  try {
    const translatable =
      translatableFrontmatter !== undefined
        ? buildTranslatableSubschemaForPayload(schema, translatableFrontmatter)
        : buildTranslatableSubschema(schema);

    const responseShape: Record<string, z.ZodTypeAny> = {
      ...(translatable ? { frontmatter: translatable } : {}),
      body: z.string(),
    };
    if (slugStrategy === "localized") {
      responseShape.slug = z.string();
    }

    const jsonSchema = z.toJSONSchema(z.object(responseShape), {
      target: "draft-2020-12",
      unrepresentable: "any",
      io: "output",
    }) as Record<string, unknown>;
    delete jsonSchema.$schema;
    return jsonSchema;
  } catch {
    return null;
  }
}
