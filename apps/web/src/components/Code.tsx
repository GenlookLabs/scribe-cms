import { getHighlighter, SHIKI_THEME } from "@/lib/highlighter";

export async function Code({ code, lang }: { code: string; lang: string }) {
  const highlighter = await getHighlighter();
  const html = highlighter.codeToHtml(code.trimEnd(), { lang, theme: SHIKI_THEME });
  // Shiki output is trusted, generated at render time from our own snippets.
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}
