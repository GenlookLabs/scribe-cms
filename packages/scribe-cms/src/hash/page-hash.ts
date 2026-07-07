import { createHash } from "node:crypto";
// tokens.js is dependency-light (it imports nothing back into hashing), so this
// import introduces no cycle.
import { extractInlineTokens } from "../inline/tokens.js";

/** SHA-256 hex digest of a UTF-8 string. */
export function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Hash translatable frontmatter + body for translation staleness detection. */
export function computePageEnHash(
  translatableFrontmatter: Record<string, unknown>,
  body: string,
): string {
  const payload = JSON.stringify({ frontmatter: translatableFrontmatter, body });
  return sha256(payload);
}

/**
 * Canonical EN hash for translation staleness. Extracts inline tokens first and
 * hashes the PLACEHOLDER body, so a token's value never restales a locale while
 * adding/removing/moving tokens does. Every staleness-relevant site (translation
 * prepare, worklist, studio badges) MUST route through this so the two ends of a
 * comparison cannot diverge. A tokenless body hashes identically to
 * `computePageEnHash(frontmatter, body)`.
 */
export function computeTranslationEnHash(
  translatableFrontmatter: Record<string, unknown>,
  body: string,
): string {
  const { placeholderBody } = extractInlineTokens(body);
  return computePageEnHash(translatableFrontmatter, placeholderBody);
}

/** Hash MDX body content for revision tracking. */
export function computeBodyHash(body: string): string {
  return sha256(body);
}
