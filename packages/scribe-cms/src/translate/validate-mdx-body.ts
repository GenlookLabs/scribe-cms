import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { normalizeTranslatedMdxBody } from "./normalize-mdx-body.js";
import { sanitizeMdxJsxAttributeQuotes } from "./sanitize-mdx-jsx.js";

const parser = unified().use(remarkParse).use(remarkMdx);

export function prepareTranslatedMdxBody(body: string): {
  body: string;
  adjusted: boolean;
} {
  const normalized = normalizeTranslatedMdxBody(body);
  const sanitized = sanitizeMdxJsxAttributeQuotes(normalized.body);
  return {
    body: sanitized.body,
    adjusted: normalized.adjusted || sanitized.adjusted,
  };
}

export function validateMdxBody(body: string): { ok: true } | { ok: false; error: string } {
  try {
    parser.parse(body);
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}

/** Normalize, sanitize, and parse-check translated MDX before persistence. */
export function assertValidTranslatedMdxBody(body: string): {
  body: string;
  adjusted: boolean;
} {
  const prepared = prepareTranslatedMdxBody(body);
  const validated = validateMdxBody(prepared.body);
  if (!validated.ok) {
    throw new Error(`MDX validation failed: ${validated.error}`);
  }
  return prepared;
}
