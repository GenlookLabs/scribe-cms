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
): Record<string, unknown> | null {
  try {
    const translatable = buildTranslatableSubschema(schema);

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
