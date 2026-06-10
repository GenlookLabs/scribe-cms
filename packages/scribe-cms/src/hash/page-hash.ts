import { createHash } from "node:crypto";

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

/** Hash MDX body content for revision tracking. */
export function computeBodyHash(body: string): string {
  return sha256(body);
}
