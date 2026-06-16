/** Detect Gemini returning JSON-style `\n` escapes as literal characters in MDX bodies. */
function needsMdxEscapeNormalization(body: string): boolean {
  return /\\n[ \t/>]|<[\w.-][^>]*\\n/.test(body);
}

/**
 * Gemini sometimes returns MDX body with JSON-style escape sequences as literal
 * characters (e.g. `\n` instead of a newline), which breaks MDX parsing.
 */
export function normalizeTranslatedMdxBody(body: string): {
  body: string;
  adjusted: boolean;
} {
  if (!needsMdxEscapeNormalization(body)) {
    return { body, adjusted: false };
  }

  const normalized = body
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");

  return { body: normalized, adjusted: normalized !== body };
}
