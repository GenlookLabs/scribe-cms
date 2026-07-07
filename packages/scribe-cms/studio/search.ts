import type { ScribeDocument } from "../src/core/types.js";
import { encodePathSegment, escapeHtml } from "./shared.js";

/**
 * Global full-text search over EN content (step 4 of the content management
 * spec). Scans, for every type's EN documents: the slug, every frontmatter value
 * (non-strings stringified), and the raw MDX body. Case-insensitive substring
 * match. No index beyond the already-loaded documents — the studio cache warms
 * `type.list()` for every type, so this is a cheap in-memory scan.
 */

const MAX_HITS_PER_TYPE = 20;
const SNIPPET_CONTEXT = 70;

/** Minimal structural view of the project so the search is unit-testable with fakes. */
interface SearchableType {
  id: string;
  config: { label: string };
  list: (locale?: string) => ScribeDocument[];
}
interface SearchableProject {
  listTypes: () => SearchableType[];
}

export interface SearchHit {
  enSlug: string;
  slug: string;
  /** Where the first match landed: a frontmatter field path, `"slug"`, or `"body"`. */
  field: string;
  /** Escaped snippet (~160 chars) with the first match wrapped in `<mark>`. */
  snippet: string;
}

export interface SearchGroup {
  typeId: string;
  label: string;
  /** Up to `MAX_HITS_PER_TYPE` hits. */
  hits: SearchHit[];
  /** Total matching documents in this type (may exceed `hits.length`). */
  total: number;
}

function valueToText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return JSON.stringify(value);
}

/** Flatten frontmatter into `{ key, text }` pairs. Nested objects recurse; arrays stringify whole. */
function frontmatterFields(
  data: Record<string, unknown>,
  prefix = "",
): Array<{ key: string; text: string }> {
  const out: Array<{ key: string; text: string }> = [];
  for (const [k, v] of Object.entries(data)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      out.push(...frontmatterFields(v as Record<string, unknown>, key));
    } else {
      out.push({ key, text: valueToText(v) });
    }
  }
  return out;
}

/** Build an escaped ~160-char snippet with the first match wrapped in `<mark>`. Escape-before-mark. */
function makeSnippet(text: string, lowerQuery: string): string {
  const idx = text.toLowerCase().indexOf(lowerQuery);
  if (idx === -1) return escapeHtml(text.slice(0, 2 * SNIPPET_CONTEXT).replace(/\s+/g, " ").trim());
  const start = Math.max(0, idx - SNIPPET_CONTEXT);
  const end = Math.min(text.length, idx + lowerQuery.length + SNIPPET_CONTEXT);
  const before = text.slice(start, idx).replace(/\s+/g, " ");
  const match = text.slice(idx, idx + lowerQuery.length);
  const after = text.slice(idx + lowerQuery.length, end).replace(/\s+/g, " ");
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${escapeHtml(before)}<mark>${escapeHtml(match)}</mark>${escapeHtml(after)}${suffix}`;
}

/** First match location for a document, in order: slug, frontmatter fields, body. */
function matchDoc(doc: ScribeDocument, lowerQuery: string): SearchHit | null {
  if (doc.slug.toLowerCase().includes(lowerQuery)) {
    return { enSlug: doc.enSlug, slug: doc.slug, field: "slug", snippet: makeSnippet(doc.slug, lowerQuery) };
  }
  const fm = doc.frontmatter as Record<string, unknown>;
  for (const f of frontmatterFields(fm)) {
    if (f.text.toLowerCase().includes(lowerQuery)) {
      return { enSlug: doc.enSlug, slug: doc.slug, field: f.key, snippet: makeSnippet(f.text, lowerQuery) };
    }
  }
  if (doc.content.toLowerCase().includes(lowerQuery)) {
    return { enSlug: doc.enSlug, slug: doc.slug, field: "body", snippet: makeSnippet(doc.content, lowerQuery) };
  }
  return null;
}

/** Run the search across every type's EN documents. Returns only types with at least one hit. */
export function searchProject(project: SearchableProject, rawQuery: string): SearchGroup[] {
  const lowerQuery = rawQuery.trim().toLowerCase();
  if (!lowerQuery) return [];
  const groups: SearchGroup[] = [];
  for (const type of project.listTypes()) {
    const hits: SearchHit[] = [];
    let total = 0;
    for (const doc of type.list()) {
      const hit = matchDoc(doc, lowerQuery);
      if (!hit) continue;
      total++;
      if (hits.length < MAX_HITS_PER_TYPE) hits.push(hit);
    }
    if (total > 0) groups.push({ typeId: type.id, label: type.config.label, hits, total });
  }
  return groups;
}

function renderGroup(group: SearchGroup): string {
  const hitRows = group.hits
    .map((h) => {
      const href = `/types/${encodePathSegment(group.typeId)}/${encodePathSegment(h.enSlug)}`;
      return `<div class="search-hit">
        <a class="mono" href="${href}">${escapeHtml(h.slug)}</a>
        <span class="search-where">${escapeHtml(h.field)}</span>
        <span class="search-snip">${h.snippet}</span>
      </div>`;
    })
    .join("");
  const more =
    group.total > group.hits.length
      ? `<div class="search-more">+${group.total - group.hits.length} more matches</div>`
      : "";
  return `<div class="search-group">
    <div class="section-head">${escapeHtml(group.label)} <span class="dim">· ${group.total}</span></div>
    ${hitRows}${more}
  </div>`;
}

/** Render the full search results page body (the sidebar form lives in the layout). */
export function renderSearchPage(project: SearchableProject, rawQuery: string): string {
  const q = rawQuery.trim();
  const toolbar = `<div class="toolbar">Search${q ? ` <span class="dim">· ${escapeHtml(q)}</span>` : ""}</div>`;
  if (!q) {
    return `${toolbar}<p class="dim" style="padding:12px">Type a query in the sidebar to search across all EN content.</p>`;
  }
  const groups = searchProject(project, rawQuery);
  if (groups.length === 0) {
    return `${toolbar}<p class="dim" style="padding:12px">No matches for "${escapeHtml(q)}".</p>`;
  }
  const totalHits = groups.reduce((n, g) => n + g.total, 0);
  const summary = `<p class="dim" style="padding:6px 12px">${totalHits} match${totalHits === 1 ? "" : "es"} in ${groups.length} type${groups.length === 1 ? "" : "s"}</p>`;
  return `${toolbar}${summary}${groups.map(renderGroup).join("")}`;
}
