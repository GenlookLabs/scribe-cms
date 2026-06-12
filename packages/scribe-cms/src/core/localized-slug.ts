/** GEN-241: translated slugs must not end with a locale code suffix. */

export function findLocaleSuffixInSlug(
  slug: string,
  localeCodes: readonly string[],
): string | undefined {
  const sorted = [...localeCodes].sort((a, b) => b.length - a.length);
  for (const code of sorted) {
    if (slug.endsWith(`-${code}`)) {
      return code;
    }
  }
  return undefined;
}

export function stripLocaleSuffixFromSlug(
  slug: string,
  localeCodes: readonly string[],
): { slug: string; stripped: boolean; matchedCode?: string } {
  const matchedCode = findLocaleSuffixInSlug(slug, localeCodes);
  if (!matchedCode) {
    return { slug, stripped: false };
  }
  return {
    slug: slug.slice(0, -(matchedCode.length + 1)),
    stripped: true,
    matchedCode,
  };
}
