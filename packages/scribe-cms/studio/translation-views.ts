import type {
  ContentTypeRuntime,
  ScribeConfig,
  ScribeDocument,
  ScribeProject,
} from "../src/core/types.js";
import {
  introspectSchema,
  isTypeTranslatable,
  mergeStructuralOntoLocale,
} from "../src/core/introspect-schema.js";
import { computeTranslationEnHash } from "../src/hash/page-hash.js";
import { getTranslatablePayload, readEnDocument } from "../src/loader/create-loader.js";
import { openStore } from "../src/storage/sqlite.js";
import {
  countTranslations,
  getEnSnapshot,
  getTranslation,
  latestTranslationAtByLocale,
  listTranslationsForType,
  type EnSnapshotRow,
} from "../src/storage/translations.js";
import { buildWorklist } from "../src/translate/worklist.js";
import { extractInlineTokens } from "../src/inline/tokens.js";
import { encodePathSegment, escapeHtml } from "./shared.js";
import { frontmatterOnlyChip, notTranslatableChip } from "./content-views.js";
import { buildPreviewTokens, makeDocExists } from "./preview-tokens.js";
import { renderMdxApprox } from "./mdx-preview.js";

/**
 * The translation surfaces, now folded into a single `/translations` section:
 * `renderTranslationsPage` renders a tabbed page (Coverage + Staleness) from
 * `renderCoveragePanel` / `renderStalenessPanel`, and `renderTranslationDetailPanel`
 * powers the per-entry "Translations" tab inside the content inspector
 * (`/types/:typeId/:enSlug?tab=translations`). The `/api/staleness-matrix` JSON
 * feed is still driven by `buildStalenessMatrix`. Each `render*Panel` returns
 * inner HTML (no chrome) so the route handlers in `server.ts` wrap them in the
 * shared layout. The translation-status view helpers (`statusDot`,
 * `documentStatus`, `batchedStatusDots`) are shared with the `/types/*` content
 * surfaces.
 */

export type DocStatus = "source" | "up-to-date" | "stale" | "missing" | "not-translatable";

export interface DocumentStatusResult {
  status: DocStatus;
  currentEnHash?: string;
  storedEnHash?: string;
}

export function statusDot(status: DocStatus): string {
  const labels: Record<DocStatus, string> = {
    source: "en",
    "up-to-date": "ok",
    stale: "stale",
    missing: "—",
    "not-translatable": "n/a",
  };
  return `<span class="status" title="${status}"><span class="dot dot-${status}"></span>${labels[status]}</span>`;
}

export function documentStatus(
  config: ScribeConfig,
  db: ReturnType<typeof openStore>,
  type: ContentTypeRuntime,
  enSlug: string,
  locale: string,
): DocumentStatusResult {
  if (locale === config.defaultLocale) {
    return { status: "source" };
  }
  // Non-translatable types have no per-locale translation state: report a
  // neutral "n/a" rather than a red "missing" for every locale.
  if (!isTypeTranslatable(type.config)) {
    return { status: "not-translatable" };
  }
  const enDoc = readEnDocument(config, type.config, enSlug);
  if (!enDoc) {
    return { status: "missing" };
  }
  const payload = getTranslatablePayload(enDoc, type.config);
  const currentEnHash = computeTranslationEnHash(payload.frontmatter, payload.body);
  const row = getTranslation(db, type.id, enSlug, locale);
  if (!row) {
    return { status: "missing", currentEnHash };
  }
  if (row.en_hash !== currentEnHash) {
    return { status: "stale", currentEnHash, storedEnHash: row.en_hash };
  }
  return { status: "up-to-date", currentEnHash, storedEnHash: row.en_hash };
}

/**
 * Precompute per-`(enSlug, locale)` translation status for a whole type in one
 * query plus one hash pass — no per-cell disk reads. `documentStatus` re-reads,
 * re-parses, and re-hashes the EN file and issues one point query per cell; on a
 * multi-locale collection page that is thousands of disk reads. Here we pull
 * every translation row for the type once, index it by `(enSlug, locale)`, and
 * hash each entry's current EN payload once from the already-cached
 * `type.list()` document. The returned closure is then a pure in-memory lookup.
 */
export function batchedStatusIndex(
  config: ScribeConfig,
  db: ReturnType<typeof openStore>,
  type: ContentTypeRuntime,
): (enSlug: string, locale: string) => DocStatus {
  const translatable = isTypeTranslatable(type.config);

  // One query for the whole type; index rows by "enSlug\x00locale".
  const rowByKey = new Map<string, { en_hash: string }>();
  // Current EN hash per entry, computed once from cached docs (no disk read).
  const enHashBySlug = new Map<string, string>();
  if (translatable) {
    for (const row of listTranslationsForType(db, type.id)) {
      rowByKey.set(`${row.en_slug}\u0000${row.locale}`, { en_hash: row.en_hash });
    }
    for (const doc of type.list() as ScribeDocument[]) {
      const payload = getTranslatablePayload(doc, type.config);
      enHashBySlug.set(doc.enSlug, computeTranslationEnHash(payload.frontmatter, payload.body));
    }
  }

  return (enSlug: string, locale: string): DocStatus => {
    if (locale === config.defaultLocale) return "source";
    if (!translatable) return "not-translatable";
    const currentEnHash = enHashBySlug.get(enSlug);
    // EN doc not in the cached list (shouldn't happen for a listed entry).
    if (currentEnHash === undefined) return "missing";
    const row = rowByKey.get(`${enSlug}\u0000${locale}`);
    if (!row) return "missing";
    if (row.en_hash !== currentEnHash) return "stale";
    return "up-to-date";
  };
}

/**
 * Batched status-dots renderer for a whole collection page: one query + one hash
 * pass, then a pure in-memory lookup per entry. Non-translatable types have no
 * per-locale status (the collection browser suppresses the column), so this
 * returns an empty string for them.
 */
export function batchedStatusDots(
  config: ScribeConfig,
  db: ReturnType<typeof openStore>,
  type: ContentTypeRuntime,
): (enSlug: string) => string {
  if (!isTypeTranslatable(type.config)) return () => "";
  const targetLocales = config.locales.filter((l) => l !== config.defaultLocale);
  const statusOf = batchedStatusIndex(config, db, type);
  return (enSlug: string): string =>
    targetLocales.map((locale) => statusDot(statusOf(enSlug, locale))).join("");
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

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

export type TranslationsTab = "coverage" | "staleness";

/**
 * The `/translations` section: a tabbed page folding the former translation
 * dashboard (Coverage) and the staleness worklist (Staleness) into one place.
 * Returns inner HTML (no chrome); `server.ts` wraps it in the shared layout.
 */
export function renderTranslationsPage(project: ScribeProject, tab: TranslationsTab): string {
  const tabs = `<div class="tabs">
      <a class="tab${tab === "coverage" ? " active" : ""}" href="/translations">Coverage</a>
      <a class="tab${tab === "staleness" ? " active" : ""}" href="/translations?tab=staleness">Staleness</a>
    </div>`;
  const panel = tab === "staleness" ? renderStalenessPanel(project) : renderCoveragePanel(project);
  return `<div class="toolbar">Translations</div>${tabs}${panel}`;
}

/** Coverage panel: KPI cards plus per-locale and per-type coverage tables. */
export function renderCoveragePanel(project: ScribeProject): string {
  const config = project.config;
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
        const fallbacks = config.localeFallbacks?.[locale]?.length
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
        const docs = docCountByType.get(type.id) ?? 0;
        if (!isTypeTranslatable(type.config)) {
          return `<tr>
            <td><a href="/types/${encodePathSegment(type.id)}">${escapeHtml(type.config.label)}</a></td>
            <td class="dim">${escapeHtml(type.id)}</td>
            <td>${docs}</td>
            <td colspan="2">${notTranslatableChip()}</td>
          </tr>`;
        }
        const stale = staleByType.get(type.id) ?? 0;
        const missing = missingByType.get(type.id) ?? 0;
        return `<tr>
            <td><a href="/types/${encodePathSegment(type.id)}">${escapeHtml(type.config.label)}</a></td>
            <td class="dim">${escapeHtml(type.id)}</td>
            <td>${docs}</td>
            <td>${num(stale, "tag-warn")}</td>
            <td>${num(missing, "tag-err")}</td>
          </tr>`;
      })
      .join("");
  }

  return `${cards}
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
}

export interface TranslationDetailParams {
  project: ScribeProject;
  config: ScribeConfig;
  type: ContentTypeRuntime;
  enSlug: string;
  locale: string;
  /** EN document already loaded by the inspector route (no double read). */
  enDoc: ScribeDocument;
  /** Show the raw (stored) locale frontmatter instead of the EN-merged view. */
  showRaw: boolean;
  bodyView: "raw" | "preview";
  /**
   * Builds the inspector URL (with `tab=translations` and the current locale)
   * for the given raw/preview flags — used by the frontmatter and body toggles.
   */
  buildHref: (raw: boolean, preview: boolean) => string;
}

/**
 * Per-locale translation detail for the inspector's "Translations" tab: status
 * meta, frontmatter (EN-merged or raw), body (raw MDX / rendered preview), and
 * the EN snapshot captured at translation time. Returns inner HTML only — the
 * inspector supplies the toolbar, locale tabs, and "Used by" panel around it.
 */
export function renderTranslationDetailPanel(params: TranslationDetailParams): string {
  const { project, config, type, enSlug, locale, enDoc, showRaw, bodyView, buildHref } = params;
  const docExists = makeDocExists(project, config);
  const db = openStore(config, "readonly");

  const bodyToggle = (rawFlag: boolean): string => `<span class="bodytabs">
      <a href="${buildHref(rawFlag, false)}" class="${bodyView === "preview" ? "" : "active"}">Raw</a>
      <a href="${buildHref(rawFlag, true)}" class="${bodyView === "preview" ? "active" : ""}">Preview</a>
    </span>`;

  let contentPanel = "";
  let metaPanel = "";
  let historyPanel = "";

  if (locale === config.defaultLocale) {
    const enTokens = extractInlineTokens(enDoc.content);
    const enPv = buildPreviewTokens(enTokens.tokens, {
      enFrontmatter: enDoc.frontmatter as Record<string, unknown>,
      docExists,
    });
    const enBodyInner =
      bodyView === "preview"
        ? `<div class="mdx-preview">${renderMdxApprox(enTokens.placeholderBody, enPv)}</div>`
        : `<pre class="code">${escapeHtml(enDoc.content)}</pre>`;
    const bodySection =
      type.config.body === false
        ? `<div class="section-head">Body</div>
        <p class="dim" style="padding:6px 12px">${frontmatterOnlyChip()}</p>`
        : `<div class="section-head">Body ${bodyToggle(false)}</div>${enBodyInner}`;
    contentPanel = `<div class="section">
        <div class="section-head">Frontmatter</div>
        <div class="section-body">${renderFrontmatterTable(enDoc.frontmatter as Record<string, unknown>, type.config.schema)}</div>
        ${bodySection}
      </div>`;
    metaPanel = `<dl class="meta"><dt>status</dt><dd>${statusDot("source")}</dd></dl>`;
  } else {
    const translation = getTranslation(db, type.id, enSlug, locale);
    const { status, currentEnHash, storedEnHash } = documentStatus(config, db, type, enSlug, locale);

    if (translation) {
      const rawFrontmatter = JSON.parse(translation.frontmatter_json) as Record<string, unknown>;
      const displayFrontmatter = showRaw
        ? rawFrontmatter
        : mergeStructuralOntoLocale(rawFrontmatter, enDoc.frontmatter as Record<string, unknown>, type.config.schema);
      const rawToggle = showRaw
        ? `<span class="dim"> · <a href="${buildHref(false, bodyView === "preview")}">merged</a></span>`
        : `<span class="dim"> · <a href="${buildHref(true, bodyView === "preview")}">raw</a></span>`;
      const trTokens = extractInlineTokens(enDoc.content).tokens;
      const trPv = buildPreviewTokens(trTokens, {
        enFrontmatter: enDoc.frontmatter as Record<string, unknown>,
        docExists,
      });
      const trBodyInner =
        bodyView === "preview"
          ? `<div class="mdx-preview">${renderMdxApprox(translation.body, trPv)}</div>`
          : `<pre class="code">${escapeHtml(translation.body)}</pre>`;
      const translationBodySection =
        type.config.body === false
          ? `<div class="section-head">Body</div>
          <p class="dim" style="padding:6px 12px">${frontmatterOnlyChip()}</p>`
          : `<div class="section-head">Body ${bodyToggle(showRaw)}</div>${trBodyInner}`;
      contentPanel = `<div class="section">
          <div class="section-head">Frontmatter${rawToggle}</div>
          <div class="section-body">${renderFrontmatterTable(displayFrontmatter, type.config.schema)}</div>
          ${translationBodySection}
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

  return `${metaPanel}${contentPanel}${historyPanel}`;
}

/** Flat staleness worklist (first 500 entries). Inner HTML only. */
export function renderStalenessPanel(project: ScribeProject): string {
  const config = project.config;
  const worklist = buildWorklist(config);
  const rows = worklist
    .slice(0, 500)
    .map((item) => {
      const href = `/types/${encodePathSegment(item.contentType)}/${encodePathSegment(item.enSlug)}?tab=translations&locale=${encodePathSegment(item.locale)}`;
      return `<tr>
          <td>${escapeHtml(item.contentType)}</td>
          <td class="mono"><a href="${href}">${escapeHtml(item.enSlug)}</a></td>
          <td>${escapeHtml(item.locale)}</td>
          <td>${statusDot(item.reason === "stale" ? "stale" : "missing")}</td>
        </tr>`;
    })
    .join("");
  return `<div class="filters"><span class="dim">${worklist.length} ${
    worklist.length === 1 ? "entry" : "entries"
  } stale or missing</span></div>
      <table class="data">
        <thead><tr><th>Type</th><th>Slug</th><th>Locale</th><th>Status</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="4" class="dim">All up to date</td></tr>`}</tbody>
      </table>`;
}

/** `typeId` → `locale` → count of stale-or-missing worklist entries (JSON feed). */
export function buildStalenessMatrix(project: ScribeProject): Record<string, Record<string, number>> {
  const config = project.config;
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
  return matrix;
}
