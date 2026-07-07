import { escapeHtml } from "./shared.js";
import type { PreviewToken } from "./preview-tokens.js";
import { unescapeInlineTokens } from "../src/inline/tokens.js";

/**
 * Rendered MDX *approximation* for the read-only studio (step 5 of the content
 * management spec). This is a sanity-check preview for humans, NOT a real MDX
 * pipeline: it never executes JSX, never resolves imports, and never emits real
 * site anchors for plain paths (hrefs are site paths that would 404 inside the
 * studio). It renders common Markdown + GFM constructs, shows JSX blocks as raw
 * escaped source, and resolves inline-token markers when preview metadata is
 * supplied.
 *
 * Safety: everything that ends up as text is escaped. Structural markers (JSX
 * tags, code fences, table pipes) are parsed from the raw source, but their text
 * content is escaped before it reaches the output. The whole render is wrapped in
 * a try/catch that falls back to a preformatted escaped block, so malformed input
 * degrades gracefully instead of throwing.
 */

let activeTokens: PreviewToken[] = [];

const TOKEN_SENTINEL_RE = /\u0000T(\d+)\u0000/g;

function tokenSentinel(n: number): string {
  return `\u0000T${n}\u0000`;
}

export function renderMdxApprox(markerBody: string, tokens: PreviewToken[] = []): string {
  activeTokens = tokens;
  try {
    const unescaped = unescapeInlineTokens(markerBody);
    const withSentinels = unescaped.replace(/%%(\d+)%%/g, (m, n: string) => {
      const idx = Number(n);
      return idx >= 1 && idx <= tokens.length ? tokenSentinel(idx) : m;
    });
    const rendered = renderBlocks(withSentinels).trim();
    return rendered.replace(TOKEN_SENTINEL_RE, (_m, n: string) => standaloneToken(tokens[Number(n) - 1]));
  } catch {
    return `<pre class="mdx-fallback">${escapeHtml(markerBody)}</pre>`;
  }
}

function countNewlines(s: string): number {
  const m = s.match(/\n/g);
  return m ? m.length : 0;
}

// ---------------------------------------------------------------------------
// Block-level parser (line based)
// ---------------------------------------------------------------------------

function renderBlocks(src: string): string {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.trim() === "") {
      i++;
      continue;
    }

    // Fenced code block (``` or ~~~).
    const fence = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      const marker = fence[2]!;
      const lang = fence[3]!.trim();
      const closeRe = new RegExp("^\\s*" + marker[0] + "{" + marker.length + ",}\\s*$");
      const buf: string[] = [];
      i++;
      while (i < lines.length && !closeRe.test(lines[i]!)) {
        buf.push(lines[i]!);
        i++;
      }
      i++; // consume the closing fence (no-op past EOF)
      const langAttr = lang ? ` data-lang="${escapeHtml(lang)}"` : "";
      out.push(`<pre class="mdx-code"${langAttr}><code>${escapeHtml(buf.join("\n"))}</code></pre>`);
      continue;
    }

    // JSX component block (capitalized tag name).
    if (/^\s*<[A-Z]/.test(line)) {
      const jsx = findJsxBlock(lines, i);
      if (jsx) {
        out.push(renderJsxRaw(jsx.raw));
        i = jsx.next;
      } else {
        out.push(`<pre class="mdx-fallback">${escapeHtml(line)}</pre>`);
        i++;
      }
      continue;
    }

    // ATX heading.
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1]!.length;
      out.push(`<h${level} class="mdx-h">${renderInline(h[2]!.trim())}</h${level}>`);
      i++;
      continue;
    }

    // Horizontal rule.
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push(`<hr class="mdx-hr" />`);
      i++;
      continue;
    }

    // GFM pipe table (header row followed by a separator row).
    if (line.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1]!)) {
      const header = splitTableRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trim() !== "" && lines[i]!.includes("|")) {
        rows.push(splitTableRow(lines[i]!));
        i++;
      }
      out.push(renderTable(header, rows));
      continue;
    }

    // Blockquote.
    if (/^\s*>/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) {
        buf.push(lines[i]!.replace(/^\s*>\s?/, ""));
        i++;
      }
      out.push(`<blockquote class="mdx-quote">${renderBlocks(buf.join("\n"))}</blockquote>`);
      continue;
    }

    // Unordered list.
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i]!)) {
        items.push(`<li>${renderInline(lines[i]!.replace(/^\s*[-*+]\s+/, ""))}</li>`);
        i++;
      }
      out.push(`<ul class="mdx-list">${items.join("")}</ul>`);
      continue;
    }

    // Ordered list.
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i]!)) {
        items.push(`<li>${renderInline(lines[i]!.replace(/^\s*\d+\.\s+/, ""))}</li>`);
        i++;
      }
      out.push(`<ol class="mdx-list">${items.join("")}</ol>`);
      continue;
    }

    // Paragraph: gather consecutive lines until a blank line or a new block start.
    const buf: string[] = [line];
    i++;
    while (i < lines.length && lines[i]!.trim() !== "" && !isBlockStart(lines[i]!, lines[i + 1])) {
      buf.push(lines[i]!);
      i++;
    }
    out.push(`<p class="mdx-p">${renderInline(buf.join(" "))}</p>`);
  }

  return out.join("\n");
}

/** Does a line begin a new block (so paragraph accumulation must stop)? */
function isBlockStart(line: string, next: string | undefined): boolean {
  if (/^\s*(`{3,}|~{3,})/.test(line)) return true;
  if (/^\s*<[A-Z]/.test(line)) return true;
  if (/^#{1,6}\s+/.test(line)) return true;
  if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) return true;
  if (/^\s*>/.test(line)) return true;
  if (/^\s*[-*+]\s+/.test(line)) return true;
  if (/^\s*\d+\.\s+/.test(line)) return true;
  if (line.includes("|") && next !== undefined && isTableSeparator(next)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

function isTableSeparator(line: string): boolean {
  if (!line.includes("-")) return false;
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

function renderTable(header: string[], rows: string[][]): string {
  const th = header.map((c) => `<th>${renderInline(c)}</th>`).join("");
  const trs = rows
    .map((r) => `<tr>${r.map((c) => `<td>${renderInline(c)}</td>`).join("")}</tr>`)
    .join("");
  return `<table class="mdx-table"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
}

// ---------------------------------------------------------------------------
// JSX component blocks (raw source)
// ---------------------------------------------------------------------------

function findJsxBlock(lines: string[], start: number): { raw: string; next: number } | null {
  const rest = lines.slice(start).join("\n");
  const open = /^\s*<([A-Z][A-Za-z0-9]*)((?:\{[^}]*\}|"[^"]*"|'[^']*'|[^>])*?)(\/?)>/.exec(rest);
  if (!open) return null;

  const name = open[1]!;
  const selfClose = open[3] === "/";
  if (selfClose) {
    const consumed = open[0]!;
    return { raw: consumed.replace(/^\s+/, ""), next: start + countNewlines(consumed) + 1 };
  }

  const afterOpen = open[0]!.length;
  const tokenRe = new RegExp(`<${name}\\b|</${name}>`, "g");
  tokenRe.lastIndex = afterOpen;
  let depth = 1;
  let closeEnd = -1;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(rest)) !== null) {
    if (m[0].startsWith("</")) {
      depth--;
      if (depth === 0) {
        closeEnd = m.index + m[0].length;
        break;
      }
    } else {
      depth++;
    }
  }
  if (closeEnd === -1) return null;

  const raw = rest.slice(0, closeEnd).replace(/^\s+/, "");
  return { raw, next: start + countNewlines(rest.slice(0, closeEnd)) + 1 };
}

function renderJsxRaw(raw: string): string {
  const escaped = escapeHtml(raw).replace(TOKEN_SENTINEL_RE, (_m, n: string) => {
    const pt = activeTokens[Number(n) - 1];
    if (!pt) return "";
    const rawLabel = escapeHtml(pt.raw);
    if (pt.kind === "relation") {
      if (pt.dangling) return `<span class="mdx-relation-broken">${rawLabel}</span>`;
      return `<a class="mdx-relation-link" href="${escapeHtml(pt.studioUrl ?? "")}">${rawLabel}</a>`;
    }
    return rawLabel;
  });
  return `<pre class="mdx-jsx-raw"><code>${escaped}</code></pre>`;
}

// ---------------------------------------------------------------------------
// Token resolution helpers
// ---------------------------------------------------------------------------

function resolveSentinelDest(dest: string): string {
  const m = /^\u0000T(\d+)\u0000$/.exec(dest);
  if (!m) return dest;
  const pt = activeTokens[Number(m[1]) - 1];
  if (!pt) return dest;
  if (pt.kind === "relation") return pt.studioUrl ?? "";
  return pt.value ?? "";
}

function standaloneToken(pt: PreviewToken | undefined): string {
  if (!pt) return "";
  if (pt.kind === "relation") {
    if (pt.dangling) {
      return `<span class="mdx-relation-broken" title="missing target">${escapeHtml(pt.label ?? "")}</span>`;
    }
    return `<a class="mdx-relation-chip" href="${escapeHtml(pt.studioUrl ?? "")}">${escapeHtml(pt.label ?? "")}</a>`;
  }
  return escapeHtml(pt.value ?? "");
}

// ---------------------------------------------------------------------------
// Inline formatting
// ---------------------------------------------------------------------------

/**
 * Render inline Markdown on a run of text. Escape FIRST, then apply the inline
 * transforms on the escaped string — the markers (`*`, `_`, backtick, brackets)
 * survive escaping, and any HTML-special characters in the content are already
 * neutralized, so nothing can inject markup.
 */
function renderInline(text: string): string {
  let s = escapeHtml(text);

  // Pull inline code spans out first so their contents are not further transformed.
  const codes: string[] = [];
  s = s.replace(/`([^`]+)`/g, (_all, c: string) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });

  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_all, alt: string, dest: string) => {
    const src = resolveSentinelDest(dest);
    return `<img class="mdx-img" src="${escapeHtml(src)}" alt="${alt}" loading="lazy" />`;
  });

  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_all, label: string, dest: string) => {
    const sm = /^\u0000T(\d+)\u0000$/.exec(dest);
    if (sm) {
      const pt = activeTokens[Number(sm[1]) - 1];
      if (pt && pt.kind === "relation") {
        if (pt.dangling) return `<span class="mdx-relation-broken" title="missing target">${label}</span>`;
        return `<a class="mdx-relation-link" href="${escapeHtml(pt.studioUrl ?? "")}">${label}</a>`;
      }
      if (pt) return `<span class="mdx-link" title="${escapeHtml(pt.value ?? "")}">${label}</span>`;
    }
    return `<span class="mdx-link" title="${escapeHtml(dest)}">${label}</span>`;
  });

  // Bold, then italic.
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  s = s.replace(/(^|[^\w])_([^_]+)_(?=[^\w]|$)/g, "$1<em>$2</em>");

  // Restore code spans.
  s = s.replace(/\u0000(\d+)\u0000/g, (_all, idx: string) => {
    return `<code class="mdx-inline-code">${codes[Number(idx)]}</code>`;
  });

  return s;
}
