import type { z } from "zod";
import type { ScribeDocument } from "../core/types.js";
import { mergeStructuralOntoLocale, pickTranslatable } from "../core/introspect-schema.js";

export function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

/** Strip non-translatable keys from Gemini frontmatter output. */
export function sanitizeTranslatedFrontmatter(
  rawFrontmatter: Record<string, unknown>,
  schema: z.ZodTypeAny,
): Record<string, unknown> {
  return pickTranslatable(rawFrontmatter, schema);
}

/** Validate locale frontmatter against the full content schema (merged with EN structural fields). */
export function validateTranslatedFrontmatter(
  enDoc: ScribeDocument,
  localeFrontmatter: Record<string, unknown>,
  typeSchema: z.ZodTypeAny,
): { ok: true; frontmatter: Record<string, unknown> } | { ok: false; error: string } {
  const frontmatter = sanitizeTranslatedFrontmatter(localeFrontmatter, typeSchema);
  const merged = mergeStructuralOntoLocale(
    frontmatter,
    enDoc.frontmatter as Record<string, unknown>,
    typeSchema,
  );
  const parsed = typeSchema.safeParse(merged);
  if (!parsed.success) {
    return { ok: false, error: formatZodIssues(parsed.error) };
  }
  return { ok: true, frontmatter };
}
