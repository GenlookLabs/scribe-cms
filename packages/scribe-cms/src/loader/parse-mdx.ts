import matter from "gray-matter";

export interface ParsedMdx {
  frontmatter: Record<string, unknown>;
  content: string;
}

export function parseMdx(raw: string): ParsedMdx {
  const parsed = matter(raw);
  return {
    frontmatter: parsed.data as Record<string, unknown>,
    content: parsed.content,
  };
}

export function serializeMdx(frontmatter: Record<string, unknown>, content: string): string {
  return matter.stringify(content, frontmatter);
}
