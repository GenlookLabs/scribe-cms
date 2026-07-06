import rehypeShikiFromHighlighter from "@shikijs/rehype/core";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified, type Processor } from "unified";
import { getHighlighter, SHIKI_THEME } from "@/lib/highlighter";

let processorPromise: Promise<Processor> | null = null;

async function buildProcessor(): Promise<Processor> {
  const highlighter = await getHighlighter();
  return unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype)
    .use(rehypeShikiFromHighlighter, highlighter, {
      theme: SHIKI_THEME,
      fallbackLanguage: "text",
    }) as unknown as Processor;
}

function getProcessor(): Promise<Processor> {
  processorPromise ??= buildProcessor();
  return processorPromise;
}

export async function Markdown({ content }: { content: string }) {
  const processor = await getProcessor();
  const mdast = processor.parse(content);
  const hast = await processor.run(mdast);
  return toJsxRuntime(hast as Parameters<typeof toJsxRuntime>[0], { Fragment, jsx, jsxs });
}
