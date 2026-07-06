import { createHighlighter, type Highlighter } from "shiki";

export const SHIKI_THEME = "github-light";
export const SHIKI_LANGS = ["ts", "tsx", "bash", "mdx", "json", "yaml", "text"];

let highlighterPromise: Promise<Highlighter> | null = null;

export function getHighlighter(): Promise<Highlighter> {
  highlighterPromise ??= createHighlighter({ themes: [SHIKI_THEME], langs: SHIKI_LANGS });
  return highlighterPromise;
}
