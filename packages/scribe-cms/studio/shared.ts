import type { ScribeProject } from "../src/core/types.js";
import { getManagedRoots } from "../src/core/managed-roots.js";
import { isTypeTranslatable } from "../src/core/introspect-schema.js";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

/** URL for the studio asset-preview route (source file off disk, not publicPath). */
export function assetPreviewUrl(webPath: string): string {
  return `/asset?p=${encodeURIComponent(webPath)}`;
}

export interface LayoutOptions {
  /** Highlighted content type in the sidebar. */
  activeTypeId?: string;
  /** Highlighted top-level nav entry ("dashboard" | "assets" | typeId). */
  activeNav?: string;
  /** Current query to prefill the sidebar search box. */
  searchQuery?: string;
}

/** The shared studio CSS. Extends the original stylesheet with content-management additions. */
export const STUDIO_CSS = `
:root {
  --bg: #1e1e1e;
  --sidebar: #252526;
  --bar: #333333;
  --panel: #1e1e1e;
  --border: #3c3c3c;
  --text: #cccccc;
  --dim: #858585;
  --accent: #3794ff;
  --hover: #2a2d2e;
  --active: #37373d;
  --ok: #89d185;
  --stale: #cca700;
  --missing: #f48771;
  --source: #75beff;
  --mono: ui-monospace, "Cascadia Code", "SF Mono", Menlo, monospace;
  --ui: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --fs: 13px;
  --fs-sm: 11px;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font: var(--fs)/1.4 var(--ui); background: var(--bg); color: var(--text); }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.app { display: flex; height: 100vh; overflow: hidden; }

/* activity bar */
.actbar {
  width: 48px; flex-shrink: 0; background: var(--bar);
  display: flex; flex-direction: column; align-items: center;
  padding: 8px 0; gap: 4px; border-right: 1px solid var(--border);
}
.actbar a {
  width: 48px; height: 48px; display: flex; align-items: center; justify-content: center;
  color: var(--dim); font-size: 18px; text-decoration: none; position: relative;
}
.actbar a:hover { color: var(--text); }
.actbar a.active { color: var(--text); }
.actbar a.active::before {
  content: ""; position: absolute; left: 0; top: 8px; bottom: 8px;
  width: 2px; background: var(--accent);
}

/* sidebar */
.sidebar {
  width: 200px; flex-shrink: 0; background: var(--sidebar);
  border-right: 1px solid var(--border); display: flex; flex-direction: column;
  overflow: hidden;
}
.sidebar-head {
  padding: 8px 12px; font-size: var(--fs-sm); font-weight: 600;
  text-transform: uppercase; letter-spacing: 0.04em; color: var(--dim);
}
.sidebar-body { flex: 1; overflow-y: auto; padding: 2px 0; }
.tree-item {
  display: flex; flex-direction: column; padding: 3px 12px 3px 20px;
  color: var(--text); text-decoration: none; line-height: 1.3;
}
.tree-item:hover { background: var(--hover); text-decoration: none; }
.tree-item.active { background: var(--active); }
.tree-label { font-size: var(--fs); }
.tree-meta { font-size: var(--fs-sm); color: var(--dim); }
.tree-item .tree-label .badge { float: right; }

/* main */
.main { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
.toolbar {
  display: flex; align-items: center; gap: 6px; padding: 0 12px;
  height: 35px; background: var(--sidebar); border-bottom: 1px solid var(--border);
  font-size: var(--fs-sm); color: var(--dim); flex-shrink: 0; overflow: hidden;
}
.toolbar a { color: var(--dim); }
.toolbar a:hover { color: var(--text); }
.toolbar .sep { color: var(--border); }
.toolbar .spacer { flex: 1; }
.content { flex: 1; overflow-y: auto; padding: 0; }

/* tabs (locale switcher) */
.tabs {
  display: flex; background: var(--sidebar); border-bottom: 1px solid var(--border);
  overflow-x: auto; flex-shrink: 0;
}
.tab {
  display: flex; align-items: center; gap: 6px; padding: 6px 12px;
  font-size: var(--fs-sm); color: var(--dim); border-right: 1px solid var(--border);
  text-decoration: none; white-space: nowrap;
}
.tab:hover { background: var(--hover); color: var(--text); text-decoration: none; }
.tab.active {
  background: var(--bg); color: var(--text);
  border-bottom: 1px solid var(--bg); margin-bottom: -1px;
}

/* status dots */
.status { display: inline-flex; align-items: center; gap: 4px; font-size: var(--fs-sm); color: var(--dim); }
.dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
.dot-source { background: var(--source); }
.dot-up-to-date { background: var(--ok); }
.dot-stale { background: var(--stale); }
.dot-missing { background: var(--missing); opacity: 0.7; }
.dot-not-translatable { background: var(--dim); opacity: 0.6; }
.dots { display: inline-flex; gap: 3px; align-items: center; }

/* sections */
.section { border-bottom: 1px solid var(--border); }
.section-head {
  padding: 4px 12px; font-size: var(--fs-sm); font-weight: 600;
  text-transform: uppercase; letter-spacing: 0.04em; color: var(--dim);
  background: var(--sidebar);
}
.section-body { padding: 0; }

/* tables */
table { border-collapse: collapse; width: 100%; font-size: var(--fs); }
.data th, .data td { padding: 2px 12px; text-align: left; border-bottom: 1px solid var(--border); vertical-align: top; }
.data th { font-size: var(--fs-sm); font-weight: 600; color: var(--dim); background: var(--sidebar); height: 22px; }
.data tr:hover td { background: var(--hover); }
.data .mono { font-family: var(--mono); font-size: var(--fs-sm); }

/* key-value (frontmatter) */
.kv td { padding: 1px 12px; font-family: var(--mono); font-size: var(--fs-sm); vertical-align: top; border-bottom: 1px solid var(--border); }
.kv .k { width: 160px; color: #9cdcfe; white-space: nowrap; }
.kv .v { color: #ce9178; white-space: pre-wrap; word-break: break-word; }
.flag { font-size: 9px; font-weight: 700; margin-right: 4px; opacity: 0.5; }
.flag.t { color: var(--ok); }
.flag.s { color: var(--dim); }

/* code block */
.code {
  margin: 0; padding: 8px 12px; font: var(--fs-sm)/1.5 var(--mono);
  white-space: pre-wrap; word-break: break-word; color: var(--text);
  background: var(--bg); border: none;
}

/* meta row */
.meta { display: flex; flex-wrap: wrap; font-size: var(--fs-sm); border-bottom: 1px solid var(--border); padding: 4px 0; }
.meta dt { padding: 0 4px 0 12px; color: var(--dim); }
.meta dt::after { content: ":"; }
.meta dd { padding: 0 12px 0 0; font-family: var(--mono); }

/* misc */
.dim { color: var(--dim); }
.page-title { padding: 8px 12px 4px; font-size: 14px; font-weight: 400; }
.page-sub { padding: 0 12px 8px; font-size: var(--fs-sm); color: var(--dim); }
details summary { cursor: pointer; color: var(--accent); font-size: var(--fs-sm); }
details[open] summary { margin-bottom: 4px; }
.tag { font-size: var(--fs-sm); color: var(--dim); margin-left: 6px; }
.tag-warn { color: var(--stale); }
.tag-err { color: var(--missing); }

/* dashboard */
.cards { display: flex; flex-wrap: wrap; gap: 1px; background: var(--border); border-bottom: 1px solid var(--border); }
.card { flex: 1 1 120px; background: var(--bg); padding: 12px; min-width: 120px; }
.card-value { font-size: 22px; font-weight: 300; line-height: 1.2; }
.card-label { font-size: var(--fs-sm); color: var(--dim); margin-top: 2px; }
.bar { display: inline-flex; width: 120px; height: 6px; background: var(--border); border-radius: 3px; overflow: hidden; vertical-align: middle; margin-right: 8px; }
.bar-fill { display: block; height: 100%; }

/* ---- content management additions ---- */

/* chips (enum / relation values) */
.chip {
  display: inline-flex; align-items: center; gap: 3px; padding: 0 6px;
  height: 16px; border-radius: 8px; font-size: 10px; line-height: 16px;
  background: var(--active); color: var(--text); margin: 1px 2px 1px 0; white-space: nowrap;
}
.chip.rel { background: #22343f; color: var(--source); }
.chip.rel-bad { background: #3f2222; color: var(--missing); }
.chip.nt { background: var(--bar); color: var(--dim); }
.chip a { color: inherit; }

/* validation badges */
.vbadge {
  display: inline-flex; align-items: center; padding: 0 6px; height: 15px;
  border-radius: 3px; font-size: 10px; font-weight: 600; line-height: 15px; margin: 0 2px;
}
.vbadge.err { background: #3f2222; color: var(--missing); }
.vbadge.warn { background: #3a3320; color: var(--stale); }
.vbadge.info { background: #22343f; color: var(--source); }
.vbadge.ok { background: #22331f; color: var(--ok); }

/* filter bar */
.filters {
  display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
  padding: 6px 12px; background: var(--sidebar); border-bottom: 1px solid var(--border);
  font-size: var(--fs-sm);
}
.filters label { display: inline-flex; align-items: center; gap: 4px; color: var(--dim); }
.filters select, .filters input[type=text] {
  background: var(--bg); color: var(--text); border: 1px solid var(--border);
  border-radius: 3px; font: var(--fs-sm) var(--ui); padding: 2px 4px;
}
.filters .reset { margin-left: auto; }
.viewtoggle { display: inline-flex; border: 1px solid var(--border); border-radius: 3px; overflow: hidden; }
.viewtoggle a { padding: 2px 8px; color: var(--dim); border-right: 1px solid var(--border); }
.viewtoggle a:last-child { border-right: none; }
.viewtoggle a.active { background: var(--active); color: var(--text); text-decoration: none; }

/* gallery */
.gallery {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 10px; padding: 12px;
}
.gcard { background: var(--sidebar); border: 1px solid var(--border); border-radius: 4px; overflow: hidden; }
.gcard .thumb {
  aspect-ratio: 1 / 1; background: #111 repeating-linear-gradient(45deg, #1a1a1a 0 8px, #161616 8px 16px);
  display: flex; align-items: center; justify-content: center; overflow: hidden;
}
.gcard .thumb img { width: 100%; height: 100%; object-fit: contain; display: block; }
.gcard .thumb .noimg { color: var(--dim); font-size: var(--fs-sm); }
.gcard .body { padding: 6px 8px; }
.gcard .gslug { font-family: var(--mono); font-size: var(--fs-sm); display: block; margin-bottom: 3px; }
.gcard .gkey { font-size: 10px; color: var(--dim); }

/* asset preview panel (inspector) */
.asset-preview { display: flex; gap: 12px; padding: 8px 12px; align-items: flex-start; }
.asset-preview .frame {
  width: 160px; height: 160px; flex-shrink: 0; border: 1px solid var(--border); border-radius: 4px;
  background: #111 repeating-linear-gradient(45deg, #1a1a1a 0 8px, #161616 8px 16px);
  display: flex; align-items: center; justify-content: center; overflow: hidden;
}
.asset-preview .frame img { max-width: 100%; max-height: 100%; object-fit: contain; }
.asset-preview .info { font-size: var(--fs-sm); }
.asset-preview .info .mono { font-family: var(--mono); color: #ce9178; }

/* asset browser grid */
.asset-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 10px; padding: 12px;
}
.acard { background: var(--sidebar); border: 1px solid var(--border); border-radius: 4px; overflow: hidden; }
.acard .athumb {
  aspect-ratio: 1 / 1;
  background: #111 repeating-linear-gradient(45deg, #1a1a1a 0 8px, #161616 8px 16px);
  display: flex; align-items: center; justify-content: center; overflow: hidden;
}
.acard .athumb img { width: 100%; height: 100%; object-fit: contain; }
.acard .abody { padding: 6px 8px; font-size: 10px; }
.acard .apath { font-family: var(--mono); font-size: 10px; color: var(--dim); word-break: break-all; display: block; margin-bottom: 3px; }

/* ---- global search ---- */
.sidebar-search { padding: 8px; border-bottom: 1px solid var(--border); }
.sidebar-search input {
  width: 100%; background: var(--bg); color: var(--text); border: 1px solid var(--border);
  border-radius: 3px; font: var(--fs-sm) var(--ui); padding: 4px 6px;
}
.search-group { border-bottom: 1px solid var(--border); }
.search-hit { padding: 6px 12px; border-bottom: 1px solid var(--border); }
.search-hit:last-child { border-bottom: none; }
.search-where { font-size: var(--fs-sm); color: var(--dim); margin-left: 8px; }
.search-snip { display: block; margin-top: 3px; font-size: var(--fs-sm); color: var(--text); font-family: var(--mono); word-break: break-word; }
.search-more { padding: 4px 12px; font-size: var(--fs-sm); color: var(--dim); }
mark { background: #3a3320; color: var(--stale); border-radius: 3px; padding: 0 2px; }

/* ---- validation tooltip ---- */
.vtip { position: relative; display: inline-block; }
.vtip-panel {
  position: absolute; right: 0; top: 100%; margin-top: 4px; z-index: 60;
  min-width: 280px; max-width: 420px; background: var(--panel, #1c1c1e);
  border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px;
  box-shadow: 0 8px 24px rgba(0,0,0,.5); text-align: left; white-space: normal; display: none;
}
.vtip:hover .vtip-panel, .vtip:focus-within .vtip-panel { display: block; }
.vrow { display: flex; align-items: baseline; gap: 6px; padding: 3px 0; font-size: var(--fs-sm); line-height: 1.4; }
.vrow .vbadge { flex-shrink: 0; }
.vrow .vmeta { font-family: var(--mono); font-size: 10px; color: var(--dim); flex-shrink: 0; }
.vrow .vmsg { color: var(--text); word-break: break-word; }
.vrow.more { color: var(--dim); }
/* The sidebar tree scrolls (overflow clips its children); pin the panel to the
   viewport so the type-badge tooltip escapes that clip. */
.tree-item .vtip-panel { position: fixed; top: auto; right: auto; }

/* ---- inspector toolbar: prev/next nav + delete ---- */
.navgroup { display: inline-flex; gap: 2px; margin-left: 6px; }
.navbtn {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 20px; height: 20px; padding: 0 5px; border: 1px solid var(--border);
  border-radius: 4px; color: var(--dim); font-size: 14px; line-height: 1; text-decoration: none;
}
.navbtn:hover { color: var(--text); background: var(--hover); text-decoration: none; }
.navbtn.disabled { opacity: 0.35; pointer-events: none; }
.btn-danger {
  color: var(--missing); border: 1px solid currentColor; border-radius: 4px; padding: 2px 8px;
  background: transparent; font: var(--fs-sm) var(--ui); text-decoration: none; cursor: pointer;
  margin-left: 6px;
}
.btn-danger:hover { background: rgba(244,135,113,0.12); text-decoration: none; }
.btn {
  color: var(--text); border: 1px solid var(--border); border-radius: 4px; padding: 4px 12px;
  background: transparent; font: var(--fs) var(--ui); text-decoration: none; cursor: pointer;
}
.btn:hover { background: var(--hover); text-decoration: none; }
.btn-lg { padding: 6px 16px; font-size: var(--fs); }

/* ---- delete confirmation page ---- */
.del-page { padding: 0 0 24px; }
.del-banner { padding: 12px; margin: 12px; border: 1px solid var(--border); border-radius: 4px; background: var(--sidebar); font-size: var(--fs); }
.del-banner.del-blocked { border-color: var(--missing); color: var(--missing); }
.del-actions { display: flex; align-items: center; gap: 10px; padding: 16px 12px; }
.del-actions form { margin: 0; }

/* ---- body raw/preview tabs ---- */
.bodytabs { margin-left: 8px; font-weight: 400; text-transform: none; }
.bodytabs a { color: var(--dim); padding: 0 4px; }
.bodytabs a.active { color: var(--text); }

/* ---- rendered MDX approximation ---- */
.mdx-preview { padding: 10px 14px; font-size: var(--fs); line-height: 1.6; }
.mdx-preview .mdx-h { margin: 12px 0 6px; line-height: 1.3; font-weight: 600; }
.mdx-preview h1.mdx-h { font-size: 20px; }
.mdx-preview h2.mdx-h { font-size: 17px; }
.mdx-preview h3.mdx-h { font-size: 15px; }
.mdx-preview h4.mdx-h, .mdx-preview h5.mdx-h, .mdx-preview h6.mdx-h { font-size: 13px; }
.mdx-preview .mdx-p { margin: 6px 0; }
.mdx-preview .mdx-list { margin: 6px 0 6px 20px; }
.mdx-preview .mdx-list li { margin: 2px 0; }
.mdx-preview .mdx-quote { border-left: 3px solid var(--border); margin: 8px 0; padding: 2px 0 2px 12px; color: var(--dim); }
.mdx-preview .mdx-hr { border: none; border-top: 1px solid var(--border); margin: 12px 0; }
.mdx-preview .mdx-code { background: var(--bg); border: 1px solid var(--border); border-radius: 4px; padding: 8px 12px; overflow-x: auto; margin: 8px 0; }
.mdx-preview .mdx-code code { font: var(--fs-sm)/1.5 var(--mono); color: var(--text); }
.mdx-preview .mdx-inline-code { font-family: var(--mono); font-size: 12px; background: var(--active); border-radius: 3px; padding: 0 4px; }
.mdx-preview .mdx-link { color: var(--accent); text-decoration: underline; text-decoration-style: dotted; cursor: help; }
.mdx-preview .mdx-table { width: auto; margin: 8px 0; border: 1px solid var(--border); }
.mdx-preview .mdx-table th, .mdx-preview .mdx-table td { border: 1px solid var(--border); padding: 3px 8px; text-align: left; }
.mdx-preview .mdx-table th { background: var(--sidebar); color: var(--text); }
.mdx-preview .mdx-fallback, pre.mdx-fallback { margin: 8px 0; padding: 8px 12px; font: var(--fs-sm)/1.5 var(--mono); white-space: pre-wrap; word-break: break-word; color: var(--dim); background: var(--bg); border: 1px dashed var(--border); }
.mdx-preview .mdx-jsx { border: 1px solid var(--border); border-radius: 4px; margin: 8px 0; background: var(--sidebar); }
.mdx-preview .mdx-jsx-head { font-family: var(--mono); font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--source); padding: 3px 8px; border-bottom: 1px solid var(--border); background: var(--bar); }
.mdx-preview .mdx-jsx-props { display: flex; flex-wrap: wrap; gap: 4px 10px; padding: 6px 8px; font-family: var(--mono); font-size: 10px; }
.mdx-preview .mdx-jsx-props .k { color: #9cdcfe; }
.mdx-preview .mdx-jsx-props .v { color: #ce9178; }
.mdx-preview .mdx-jsx-children { padding: 4px 8px; }
`;

/** Render the shared studio chrome (activity bar + type sidebar + content). */
export function renderLayout(
  title: string,
  body: string,
  project: ScribeProject,
  options: LayoutOptions & { typeBadges?: Map<string, string> } = {},
): string {
  const typeLinks = project
    .listTypes()
    .map((type) => {
      const active = type.id === options.activeTypeId ? " active" : "";
      const badge = options.typeBadges?.get(type.id) ?? "";
      // Neutral marker (not a red/warning badge): this type has nothing to
      // translate, so it carries no per-locale status anywhere in the studio.
      const ntChip = isTypeTranslatable(type.config)
        ? ""
        : ` <span class="chip nt" title="No translatable fields and no body">not translatable</span>`;
      return `<a class="tree-item${active}" href="/types/${encodePathSegment(type.id)}">
        <span class="tree-label">${escapeHtml(type.config.label)}${badge}${ntChip}</span>
        <span class="tree-meta">${escapeHtml(type.id)}</span>
      </a>`;
    })
    .join("");

  const assetsEnabled = getManagedRoots(project.config).length > 0 || Boolean(project.config.assets);
  const assetsNav = assetsEnabled
    ? `<a href="/assets" title="Assets"${options.activeNav === "assets" ? ' class="active"' : ""}>▤</a>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} — Scribe</title>
  <style>${STUDIO_CSS}</style>
</head>
<body>
  <div class="app">
    <nav class="actbar">
      <a href="/" title="Overview">⌂</a>
      <a href="/dashboard" title="Dashboard"${options.activeNav === "dashboard" ? ' class="active"' : ""}>▦</a>
      <a href="/staleness" title="Staleness">⚠</a>
      ${assetsNav}
    </nav>
    <aside class="sidebar">
      <form class="sidebar-search" method="get" action="/search">
        <input type="search" name="q" value="${escapeHtml(options.searchQuery ?? "")}" placeholder="Search content…" aria-label="Search content" />
      </form>
      <div class="sidebar-head">Types</div>
      <div class="sidebar-body">${typeLinks || `<span class="dim" style="padding:8px 12px">—</span>`}</div>
    </aside>
    <div class="main">
      <div class="content">${body}</div>
    </div>
  </div>
</body>
</html>`;
}
