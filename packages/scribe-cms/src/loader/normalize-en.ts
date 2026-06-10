export function normalizeEnFrontmatter(data: Record<string, unknown>): Record<string, unknown> {
  const out = { ...data };
  if (!out.publishedAt && typeof out.date === "string") {
    out.publishedAt = out.date;
  }
  if (!out.heroImage && typeof out.image === "string" && out.image.startsWith("/")) {
    out.heroImage = out.image;
  }
  if (!out.updatedAt && typeof out.publishedAt === "string") {
    out.updatedAt = out.publishedAt;
  }
  return out;
}

export function isPublishableContentFile(name: string): boolean {
  if (!name.endsWith(".md") && !name.endsWith(".mdx")) return false;
  const first = name.charAt(0);
  return first === first.toLowerCase() && first !== "_";
}
