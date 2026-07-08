// Generates the static Markdown mirror of every routable document plus a
// top-level llms.txt, both under apps/web/public. Run at build time by the
// "build" script in package.json. The public/ dir is fully generated (see
// .gitignore) and wiped per run by writeStaticRawExports.
//
// We use the programmatic createProject API (not the `scribe export` CLI)
// because only this path resolves inline ${{...}} tokens, and we want the
// exported Markdown to carry real links with an ".md" extension so agents can
// follow them to sibling exports.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createProject, loadConfigSync, writeStaticRawExports } from "scribe-cms";

const SITE_URL = "https://scribe.genlook.app";
const OUT_DIR = "public";

const config = loadConfigSync();
const project = createProject(config, {
  resolveInlineTokens: true,
  inlineLinkStyle: "export",
  exportLinkExtension: ".md",
});

// Write {segment}/{slug}.md for the default locale and {locale}/{segment}/{slug}.md
// for every other locale. Wipes the managed export roots first.
const { written } = writeStaticRawExports(project, {
  outDir: OUT_DIR,
  extension: ".md",
});
console.log(`Wrote ${written} static Markdown exports to ${OUT_DIR}/`);

// llms.txt: English only, absolute URLs. Docs ordered by frontmatter order,
// blog newest first (both follow the type's configured orderBy).
const en = config.defaultLocale;
const docs = project.getType("doc").list(en);
const posts = project.getType("blog").list(en);

const docLines = docs
  .map(
    (doc) =>
      `- [${doc.frontmatter.title}](${SITE_URL}/docs/${doc.enSlug}.md): ${doc.frontmatter.description}`,
  )
  .join("\n");

const blogLines = posts
  .map(
    (post) =>
      `- [${post.frontmatter.title}](${SITE_URL}/blog/${post.enSlug}.md): ${post.frontmatter.description}`,
  )
  .join("\n");

const llms = `# Scribe CMS

> A typed, git-based CMS for multilingual MDX sites. English content lives in MDX files in the repo, translations in a committed SQLite store, and a typed runtime reads everything at build time. No CMS server.

Every docs and blog page is also available as raw Markdown: append \`.md\` to its URL, or use the links below.

## Docs

${docLines}

## Blog

${blogLines}

## Changelog

- [Changelog](${SITE_URL}/changelog): release notes for scribe-cms.
`;

writeFileSync(join(OUT_DIR, "llms.txt"), llms, "utf8");
console.log(`Wrote ${OUT_DIR}/llms.txt (${docs.length} docs, ${posts.length} blog posts)`);
