import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { ContentTypeRuntime, ScribeConfig, ScribeProject } from "../src/core/types.js";
import { introspectSchema, mergeStructuralOntoLocale } from "../src/core/introspect-schema.js";
import { computePageEnHash } from "../src/hash/page-hash.js";
import { getTranslatablePayload, readEnDocument } from "../src/loader/create-loader.js";
import { openStore } from "../src/storage/sqlite.js";
import {
  countTranslations,
  getEnSnapshot,
  getTranslation,
  latestTranslationAtByLocale,
  listTranslationsForLocale,
  type EnSnapshotRow,
} from "../src/storage/translations.js";
import { buildWorklist } from "../src/translate/worklist.js";

type DocStatus = "source" | "up-to-date" | "stale" | "missing";

interface DocumentStatusResult {
  status: DocStatus;
  currentEnHash?: string;
  storedEnHash?: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

function statusDot(status: DocStatus): string {
  const labels: Record<DocStatus, string> = {
    source: "en",
    "up-to-date": "ok",
    stale: "stale",
    missing: "—",
  };
  return `<span class="status" title="${status}"><span class="dot dot-${status}"></span>${labels[status]}</span>`;
}

function documentStatus(
  config: ScribeConfig,
  db: ReturnType<typeof openStore>,
  type: ContentTypeRuntime,
  enSlug: string,
  locale: string,
): DocumentStatusResult {
  if (locale === config.defaultLocale) {
    return { status: "source" };
  }
  const enDoc = readEnDocument(config, type.config, enSlug);
  if (!enDoc) {
    return { status: "missing" };
  }
  const payload = getTranslatablePayload(enDoc, type.config);
  const currentEnHash = computePageEnHash(payload.frontmatter, payload.body);
  const row = getTranslation(db, type.id, enSlug, locale);
  if (!row) {
    return { status: "missing", currentEnHash };
  }
  if (row.en_hash !== currentEnHash) {
    return { status: "stale", currentEnHash, storedEnHash: row.en_hash };
  }
  return { status: "up-to-date", currentEnHash, storedEnHash: row.en_hash };
}

function flattenFrontmatter(
  data: Record<string, unknown>,
  prefix = "",
): Array<{ key: string; value: string }> {
  const rows: Array<{ key: string; value: string }> = [];
  for (const [key, value] of Object.entries(data)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      rows.push(...flattenFrontmatter(value as Record<string, unknown>, fullKey));
    } else {
      const display =
        typeof value === "string"
          ? value
          : value === undefined
            ? ""
            : JSON.stringify(value, null, 2);
      rows.push({ key: fullKey, value: display });
    }
  }
  return rows;
}

function translatableKeySet(schema: ContentTypeRuntime["config"]["schema"]): Set<string> {
  return new Set(
    introspectSchema(schema)
      .filter((field) => field.kind === "translatable")
      .map((field) => field.path.join(".")),
  );
}

function renderFrontmatterTable(
  frontmatter: Record<string, unknown>,
  schema: ContentTypeRuntime["config"]["schema"],
): string {
  const translatable = translatableKeySet(schema);
  const rows = flattenFrontmatter(frontmatter)
    .map((row) => {
      const flag = translatable.has(row.key)
        ? `<span class="flag t" title="Translatable">T</span>`
        : `<span class="flag s" title="Structural">S</span>`;
      return `<tr>
        <td class="k">${flag}${escapeHtml(row.key)}</td>
        <td class="v">${escapeHtml(row.value)}</td>
      </tr>`;
    })
    .join("");
  return `<table class="kv">
    <tbody>${rows || `<tr><td colspan="2" class="dim">—</td></tr>`}</tbody>
  </table>`;
}

function renderEnSnapshotPreview(snapshot: EnSnapshotRow): string {
  let frontmatter: Record<string, unknown> = {};
  try {
    frontmatter = JSON.parse(snapshot.frontmatter_json) as Record<string, unknown>;
  } catch {
    frontmatter = {};
  }
  const fmRows = flattenFrontmatter(frontmatter)
    .map(
      (row) =>
        `<tr><td class="k">${escapeHtml(row.key)}</td><td class="v">${escapeHtml(row.value)}</td></tr>`,
    )
    .join("");
  return `<table class="kv"><tbody>${fmRows}</tbody></table>
    <pre class="code">${escapeHtml(snapshot.body)}</pre>`;
}

function renderTranslationSnapshotPanel(
  snapshot: EnSnapshotRow | undefined,
  currentEnHash?: string,
): string {
  if (!snapshot) {
    return `<p class="dim">No EN snapshot linked to this translation.</p>`;
  }
  const staleNote =
    currentEnHash && currentEnHash !== snapshot.en_hash
      ? `<p class="dim">Current EN hash differs from snapshot (${escapeHtml(currentEnHash.slice(0, 12))} vs ${escapeHtml(snapshot.en_hash.slice(0, 12))}).</p>`
      : "";
  return `<dl class="meta">
    <dt>snapshot</dt><dd>#${snapshot.id}</dd>
    <dt>captured</dt><dd>${escapeHtml(snapshot.created_at.slice(0, 19))}</dd>
    <dt>en_hash</dt><dd class="mono">${escapeHtml(snapshot.en_hash.slice(0, 12))}</dd>
  </dl>
  ${staleNote}
  <details><summary>EN source at translation time</summary>${renderEnSnapshotPreview(snapshot)}</details>`;
}

function renderLayout(
  title: string,
  body: string,
  project: ScribeProject,
  options: { activeTypeId?: string } = {},
): string {
  const typeLinks = project
    .listTypes()
    .map((type) => {
      const active = type.id === options.activeTypeId ? " active" : "";
      return `<a class="tree-item${active}" href="/type/${encodePathSegment(type.id)}">
        <span class="tree-label">${escapeHtml(type.config.label)}</span>
        <span class="tree-meta">${escapeHtml(type.id)}</span>
      </a>`;
    })
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} — Scribe</title>
  <style>
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
  </style>
</head>
<body>
  <div class="app">
    <nav class="actbar">
      <a href="/" title="Overview">⌂</a>
      <a href="/dashboard" title="Dashboard">▦</a>
      <a href="/staleness" title="Staleness">⚠</a>
    </nav>
    <aside class="sidebar">
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

function docTitleFromFrontmatter(frontmatter: Record<string, unknown>, enSlug: string): string {
  const title = frontmatter.title;
  if (typeof title === "string" && title.trim()) return title;
  return enSlug;
}

/** Start a local read-only Scribe studio (browser, staleness, document detail). */
export async function startStudio(
  project: ScribeProject,
  options: { port?: number; host?: string } = {},
): Promise<void> {
  const app = new Hono();
  const config = project.config;

  app.get("/", (c) => {
    const db = openStore(config, "readonly");
    const worklist = buildWorklist(config);
    const rows = project.listTypes().map((type) => {
      const enCount = type.list().length;
      const localeCells = config.locales
        .filter((locale) => locale !== config.defaultLocale)
        .map((locale) => {
          const translated = listTranslationsForLocale(db, type.id, locale).length;
          const stale = worklist.filter(
            (item) =>
              item.contentType === type.id && item.locale === locale && item.reason === "stale",
          ).length;
          const missing = worklist.filter(
            (item) =>
              item.contentType === type.id && item.locale === locale && item.reason === "missing",
          ).length;
          const tags = [
            stale ? `<span class="tag tag-warn">${stale}s</span>` : "",
            missing ? `<span class="tag tag-err">${missing}m</span>` : "",
          ].join("");
          return `<td>${translated}${tags}</td>`;
        })
        .join("");
      return `<tr>
        <td><a href="/type/${encodePathSegment(type.id)}">${escapeHtml(type.config.label)}</a></td>
        <td class="dim">${escapeHtml(type.id)}</td>
        <td>${enCount}</td>
        ${localeCells}
      </tr>`;
    });
    db.close();
    const localeHeaders = config.locales
      .filter((l) => l !== config.defaultLocale)
      .map((l) => `<th>${escapeHtml(l)}</th>`)
      .join("");
    const html = `<div class="toolbar">Overview</div>
      <table class="data">
        <thead><tr><th>Type</th><th>ID</th><th>EN</th>${localeHeaders}</tr></thead>
        <tbody>${rows.join("")}</tbody>
      </table>`;
    return c.html(renderLayout("Overview", html, project));
  });

  app.get("/dashboard", (c) => {
    const db = openStore(config, "readonly");
    const types = project.listTypes();
    const targetLocales = config.locales.filter((l) => l !== config.defaultLocale);

    // EN doc counts per type + total.
    const docCountByType = new Map<string, number>();
    let totalEnDocs = 0;
    for (const type of types) {
      const n = type.list().length;
      docCountByType.set(type.id, n);
      totalEnDocs += n;
    }

    // Single pass over the worklist for per-locale and per-type tallies.
    const worklist = buildWorklist(config);
    const missingByLocale = new Map<string, number>();
    const staleByLocale = new Map<string, number>();
    const missingByType = new Map<string, number>();
    const staleByType = new Map<string, number>();
    let missingTotal = 0;
    let staleTotal = 0;
    for (const item of worklist) {
      if (item.reason === "missing") {
        missingByLocale.set(item.locale, (missingByLocale.get(item.locale) ?? 0) + 1);
        missingByType.set(item.contentType, (missingByType.get(item.contentType) ?? 0) + 1);
        missingTotal++;
      } else if (item.reason === "stale") {
        staleByLocale.set(item.locale, (staleByLocale.get(item.locale) ?? 0) + 1);
        staleByType.set(item.contentType, (staleByType.get(item.contentType) ?? 0) + 1);
        staleTotal++;
      }
    }

    const storedTranslations = countTranslations(db);
    const latestByLocale = new Map<string, string>();
    for (const row of latestTranslationAtByLocale(db)) {
      if (row.latest) latestByLocale.set(row.locale, row.latest);
    }
    db.close();

    // Overall coverage.
    const expectedTotal = totalEnDocs * targetLocales.length;
    const coverageTotal =
      expectedTotal > 0 ? (expectedTotal - missingTotal - staleTotal) / expectedTotal : 0;
    const coveragePct = expectedTotal > 0 ? Math.round(coverageTotal * 100) : 0;

    const pct = (fraction: number) => Math.round(fraction * 100);
    const num = (n: number, warnClass: string) =>
      n > 0 ? `<span class="${warnClass}">${n}</span>` : `<span class="dim">0</span>`;

    // KPI cards.
    const coverageColor = expectedTotal > 0 && coveragePct === 100 ? ` style="color:var(--ok)"` : "";
    const coverageValue = expectedTotal > 0 ? `${coveragePct}%` : `<span class="dim">—</span>`;
    const staleColor = staleTotal > 0 ? ` style="color:var(--stale)"` : "";
    const missingColor = missingTotal > 0 ? ` style="color:var(--missing)"` : "";
    const cards = `<div class="cards">
      <div class="card"><div class="card-value">${totalEnDocs}</div><div class="card-label">Documents (EN)</div></div>
      <div class="card"><div class="card-value">${targetLocales.length}</div><div class="card-label">Target locales</div></div>
      <div class="card"><div class="card-value">${storedTranslations}</div><div class="card-label">Stored translations</div></div>
      <div class="card"><div class="card-value"${coverageColor}>${coverageValue}</div><div class="card-label">Coverage</div></div>
      <div class="card"><div class="card-value"${staleColor}>${staleTotal}</div><div class="card-label">Stale</div></div>
      <div class="card"><div class="card-value"${missingColor}>${missingTotal}</div><div class="card-label">Missing</div></div>
    </div>`;

    // Locales section.
    let localeRows: string;
    if (totalEnDocs === 0 || targetLocales.length === 0) {
      localeRows = `<tr><td colspan="7" class="dim">No target locales or documents</td></tr>`;
    } else {
      localeRows = targetLocales
        .map((locale) => {
          const expected = totalEnDocs;
          const missing = missingByLocale.get(locale) ?? 0;
          const stale = staleByLocale.get(locale) ?? 0;
          const translated = expected - missing;
          const upToDate = translated - stale;
          const upToDatePct = pct(expected > 0 ? upToDate / expected : 0);
          const stalePct = pct(expected > 0 ? stale / expected : 0);
          const fallbacks = config.localeFallbacks[locale]?.length
            ? escapeHtml(config.localeFallbacks[locale]!.join(" → "))
            : `<span class="dim">—</span>`;
          const latest = latestByLocale.get(locale);
          const last = latest ? escapeHtml(latest.slice(0, 10)) : `<span class="dim">—</span>`;
          return `<tr>
            <td>${escapeHtml(locale)}</td>
            <td><span class="bar"><span class="bar-fill" style="width:${upToDatePct}%;background:var(--ok)"></span><span class="bar-fill" style="width:${stalePct}%;background:var(--stale)"></span></span>${upToDatePct}%</td>
            <td>${upToDate}</td>
            <td>${num(stale, "tag-warn")}</td>
            <td>${num(missing, "tag-err")}</td>
            <td>${fallbacks}</td>
            <td>${last}</td>
          </tr>`;
        })
        .join("");
    }

    // Types section.
    let typeRows: string;
    if (types.length === 0 || targetLocales.length === 0) {
      typeRows = `<tr><td colspan="5" class="dim">No types or target locales</td></tr>`;
    } else {
      typeRows = types
        .map((type) => {
          const stale = staleByType.get(type.id) ?? 0;
          const missing = missingByType.get(type.id) ?? 0;
          return `<tr>
            <td><a href="/type/${encodePathSegment(type.id)}">${escapeHtml(type.config.label)}</a></td>
            <td class="dim">${escapeHtml(type.id)}</td>
            <td>${docCountByType.get(type.id) ?? 0}</td>
            <td>${num(stale, "tag-warn")}</td>
            <td>${num(missing, "tag-err")}</td>
          </tr>`;
        })
        .join("");
    }

    const html = `<div class="toolbar">Dashboard</div>
      ${cards}
      <div class="section">
        <div class="section-head">Locales</div>
        <table class="data">
          <thead><tr><th>Locale</th><th>Coverage</th><th>Up to date</th><th>Stale</th><th>Missing</th><th>Fallbacks</th><th>Last translated</th></tr></thead>
          <tbody>${localeRows}</tbody>
        </table>
      </div>
      <div class="section">
        <div class="section-head">Types</div>
        <table class="data">
          <thead><tr><th>Type</th><th>ID</th><th>EN docs</th><th>Stale</th><th>Missing</th></tr></thead>
          <tbody>${typeRows}</tbody>
        </table>
      </div>`;
    return c.html(renderLayout("Dashboard", html, project));
  });

  app.get("/type/:id", (c) => {
    const typeId = c.req.param("id");
    const type = project.getType(typeId);
    if (!type) {
      return c.html(renderLayout("Not found", `<div class="toolbar">Unknown type</div>`, project), 404);
    }

    const db = openStore(config, "readonly");
    const locales = config.locales;
    const headerCells = locales
      .map((locale) => `<th>${escapeHtml(locale)}</th>`)
      .join("");
    const rows = type
      .list()
      .map((doc) => {
        const title = docTitleFromFrontmatter(doc.frontmatter as Record<string, unknown>, doc.slug);
        const statusCells = locales
          .map((locale) => {
            const { status } = documentStatus(config, db, type, doc.slug, locale);
            return `<td>${statusDot(status)}</td>`;
          })
          .join("");
        return `<tr>
          <td class="mono"><a href="/type/${encodePathSegment(typeId)}/doc/${encodePathSegment(doc.slug)}">${escapeHtml(doc.slug)}</a></td>
          <td>${escapeHtml(title)}</td>
          ${statusCells}
        </tr>`;
      })
      .join("");
    db.close();

    const html = `<div class="toolbar">
        <a href="/">Overview</a><span class="sep">›</span>${escapeHtml(type.config.label)}
      </div>
      <table class="data">
        <thead><tr><th>Slug</th><th>Title</th>${headerCells}</tr></thead>
        <tbody>${rows || `<tr><td colspan="${2 + locales.length}" class="dim">No documents</td></tr>`}</tbody>
      </table>`;
    return c.html(renderLayout(type.config.label, html, project, { activeTypeId: typeId }));
  });

  app.get("/type/:id/doc/:enSlug", (c) => {
    const typeId = c.req.param("id");
    const enSlug = c.req.param("enSlug");
    const locale = c.req.query("locale") ?? config.defaultLocale;
    const showRaw = c.req.query("raw") === "1";
    const type = project.getType(typeId);
    if (!type) {
      return c.html(renderLayout("Not found", `<div class="toolbar">Unknown type</div>`, project), 404);
    }

    const db = openStore(config, "readonly");
    const enDoc = readEnDocument(config, type.config, enSlug);
    if (!enDoc) {
      db.close();
      return c.html(
        renderLayout("Not found", `<div class="toolbar">Not found</div><p class="dim" style="padding:12px">${escapeHtml(enSlug)}</p>`, project, {
          activeTypeId: typeId,
        }),
        404,
      );
    }

    const localeTabs = config.locales
      .map((loc) => {
        const { status } = documentStatus(config, db, type, enSlug, loc);
        const active = loc === locale ? " active" : "";
        const href = `/type/${encodePathSegment(typeId)}/doc/${encodePathSegment(enSlug)}?locale=${encodePathSegment(loc)}`;
        return `<a class="tab${active}" href="${href}">${escapeHtml(loc)} ${statusDot(status)}</a>`;
      })
      .join("");

    let contentPanel = "";
    let metaPanel = "";
    let historyPanel = "";

    if (locale === config.defaultLocale) {
      contentPanel = `<div class="section">
        <div class="section-head">Frontmatter</div>
        <div class="section-body">${renderFrontmatterTable(enDoc.frontmatter as Record<string, unknown>, type.config.schema)}</div>
        <div class="section-head">Body</div>
        <pre class="code">${escapeHtml(enDoc.content)}</pre>
      </div>`;
    } else {
      const translation = getTranslation(db, typeId, enSlug, locale);
      const { status, currentEnHash, storedEnHash } = documentStatus(config, db, type, enSlug, locale);

      if (translation) {
        const rawFrontmatter = JSON.parse(translation.frontmatter_json) as Record<string, unknown>;
        const displayFrontmatter = showRaw
          ? rawFrontmatter
          : mergeStructuralOntoLocale(rawFrontmatter, enDoc.frontmatter as Record<string, unknown>, type.config.schema);
        const rawToggle = showRaw
          ? `<span class="dim"> · <a href="?locale=${encodePathSegment(locale)}">merged</a></span>`
          : `<span class="dim"> · <a href="?locale=${encodePathSegment(locale)}&raw=1">raw</a></span>`;
        contentPanel = `<div class="section">
          <div class="section-head">Frontmatter${rawToggle}</div>
          <div class="section-body">${renderFrontmatterTable(displayFrontmatter, type.config.schema)}</div>
          <div class="section-head">Body</div>
          <pre class="code">${escapeHtml(translation.body)}</pre>
        </div>`;
        metaPanel = `<dl class="meta">
          <dt>status</dt><dd>${statusDot(status)}</dd>
          <dt>model</dt><dd>${escapeHtml(translation.model)}</dd>
          <dt>translated</dt><dd>${escapeHtml(translation.translated_at.slice(0, 19))}</dd>
          <dt>slug</dt><dd>${escapeHtml(translation.slug)}</dd>
          <dt>en_hash</dt><dd>${escapeHtml(currentEnHash?.slice(0, 12) ?? "—")} / ${escapeHtml(storedEnHash?.slice(0, 12) ?? "—")}</dd>
        </dl>`;
        const snapshot =
          translation.snapshot_id != null
            ? getEnSnapshot(db, translation.snapshot_id)
            : undefined;
        historyPanel = `<div class="section">
          <div class="section-head">EN snapshot</div>
          <div class="section-body">${renderTranslationSnapshotPanel(snapshot, currentEnHash)}</div>
        </div>`;
      } else {
        contentPanel = `<p class="dim" style="padding:12px">No translation for ${escapeHtml(locale)}.</p>`;
        metaPanel = `<dl class="meta"><dt>status</dt><dd>${statusDot(status)}</dd></dl>`;
      }
    }

    db.close();

    const title = docTitleFromFrontmatter(enDoc.frontmatter as Record<string, unknown>, enSlug);
    const html = `<div class="toolbar">
        <a href="/">Overview</a><span class="sep">›</span>
        <a href="/type/${encodePathSegment(typeId)}">${escapeHtml(type.config.label)}</a><span class="sep">›</span>
        <span>${escapeHtml(enSlug)}</span>
      </div>
      <div class="tabs">${localeTabs}</div>
      ${metaPanel}
      ${contentPanel}
      ${historyPanel}`;

    return c.html(renderLayout(title, html, project, { activeTypeId: typeId }));
  });

  app.get("/staleness", (c) => {
    const worklist = buildWorklist(config);
    const rows = worklist
      .slice(0, 500)
      .map((item) => {
        const href = `/type/${encodePathSegment(item.contentType)}/doc/${encodePathSegment(item.enSlug)}?locale=${encodePathSegment(item.locale)}`;
        return `<tr>
          <td>${escapeHtml(item.contentType)}</td>
          <td class="mono"><a href="${href}">${escapeHtml(item.enSlug)}</a></td>
          <td>${escapeHtml(item.locale)}</td>
          <td>${statusDot(item.reason === "stale" ? "stale" : "missing")}</td>
        </tr>`;
      })
      .join("");
    const html = `<div class="toolbar">Staleness <span class="dim">· ${worklist.length} entries</span></div>
      <table class="data">
        <thead><tr><th>Type</th><th>Slug</th><th>Locale</th><th>Status</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="4" class="dim">All up to date</td></tr>`}</tbody>
      </table>`;
    return c.html(renderLayout("Staleness", html, project));
  });

  app.get("/api/staleness-matrix", (c) => {
    const worklist = buildWorklist(config);
    const matrix: Record<string, Record<string, number>> = {};
    for (const type of project.listTypes()) {
      matrix[type.id] = {};
      for (const locale of config.locales) {
        if (locale === config.defaultLocale) continue;
        matrix[type.id]![locale] = worklist.filter(
          (item) => item.contentType === type.id && item.locale === locale,
        ).length;
      }
    }
    return c.json(matrix);
  });

  const port = options.port ?? 3600;
  const host = options.host ?? "127.0.0.1";
  serve({ fetch: app.fetch, port, hostname: host }, () => {
    console.log(`Scribe studio listening on http://${host}:${port}`);
  });
}
