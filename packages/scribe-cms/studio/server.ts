import fs from "node:fs";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
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
  listTranslationsForLocale,
  listTranslationsForType,
  type EnSnapshotRow,
} from "../src/storage/translations.js";
import { buildWorklist } from "../src/translate/worklist.js";
import { validateProject } from "../src/validate/validate-project.js";
import {
  encodePathSegment as sharedEncodePathSegment,
  escapeHtml as sharedEscapeHtml,
  renderLayout as sharedRenderLayout,
} from "./shared.js";
import { buildIndexes } from "./introspect-fields.js";
import {
  bucketValidation,
  frontmatterOnlyChip,
  notTranslatableChip,
  renderCollectionBrowser,
  renderDeletionPlanPage,
  renderEntryInspector,
  renderUsedBy,
  typeBadges,
  type InspectorContext,
  type ValidationBuckets,
} from "./content-views.js";
import { renderAssetBrowser } from "./asset-views.js";
import { buildDeletionPlan, isPlanBlocked, type DeletionPlan } from "../src/delete/plan.js";
import { executeDeletionPlan } from "../src/delete/execute.js";
import { renderSearchPage } from "./search.js";
import { contentTypeForPath, resolveAssetWebPath, serveStudioAsset, statAsset } from "./asset-serve.js";
import { extractInlineTokens } from "../src/inline/tokens.js";
import { buildPreviewTokens, makeDocExists } from "./preview-tokens.js";
import { renderMdxApprox } from "./mdx-preview.js";
import { StudioCache, computeContentFingerprint } from "./studio-cache.js";

type DocStatus = "source" | "up-to-date" | "stale" | "missing" | "not-translatable";

interface DocumentStatusResult {
  status: DocStatus;
  currentEnHash?: string;
  storedEnHash?: string;
}

const escapeHtml = sharedEscapeHtml;
const encodePathSegment = sharedEncodePathSegment;

function statusDot(status: DocStatus): string {
  const labels: Record<DocStatus, string> = {
    source: "en",
    "up-to-date": "ok",
    stale: "stale",
    missing: "—",
    "not-translatable": "n/a",
  };
  return `<span class="status" title="${status}"><span class="dot dot-${status}"></span>${labels[status]}</span>`;
}

function bodyToggleFor(locale: string, showRaw: boolean, preview: boolean): string {
  const q = (withPreview: boolean) => {
    const parts = [`locale=${encodePathSegment(locale)}`];
    if (showRaw) parts.push("raw=1");
    if (withPreview) parts.push("body=preview");
    return "?" + parts.join("&");
  };
  return `<span class="bodytabs">
      <a href="${q(false)}" class="${preview ? "" : "active"}">Raw</a>
      <a href="${q(true)}" class="${preview ? "active" : ""}">Preview</a>
    </span>`;
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

/** Thin wrapper over the shared studio layout (adds the Assets nav + type badges). */
function renderLayout(
  title: string,
  body: string,
  project: ScribeProject,
  options: {
    activeTypeId?: string;
    activeNav?: string;
    typeBadges?: Map<string, string>;
    searchQuery?: string;
  } = {},
): string {
  return sharedRenderLayout(title, body, project, options);
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

  // Back-ref + asset-reference indexes and the validation report are derived
  // once per content-change tick (a cheap file-count/mtime/store fingerprint)
  // and served stale-while-revalidate: only the first build blocks a request;
  // after that a fingerprint change returns the current value immediately and
  // refreshes in the background. See studio-cache.ts. The validation report
  // parses every EN + translated MDX body, which is multiple seconds on a large
  // project — doing it inline made `/types/:id` block for ~5s after any edit.
  interface StudioCacheValue {
    backRefs: ReturnType<typeof buildIndexes>["backRefs"];
    assetRefs: ReturnType<typeof buildIndexes>["assetRefs"];
    buckets: ValidationBuckets;
    typeBadges: Map<string, string>;
  }

  const studioCache = new StudioCache<StudioCacheValue>({
    fingerprint: () => computeContentFingerprint(project, config),
    build: () => {
      const { backRefs, assetRefs } = buildIndexes(project.listTypes());
      let buckets: ValidationBuckets;
      try {
        buckets = bucketValidation(validateProject(config).issues);
      } catch {
        buckets = bucketValidation([]);
      }
      return { backRefs, assetRefs, buckets, typeBadges: typeBadges(buckets) };
    },
    // First-paint placeholder so even the very first request doesn't block on the
    // multi-second MDX validation pass. Back-refs/badges fill in a moment later.
    initial: () => {
      const empty = bucketValidation([]);
      return {
        backRefs: new Map(),
        assetRefs: new Map(),
        buckets: empty,
        typeBadges: typeBadges(empty),
      };
    },
    onError: (err) => console.error("[scribe:studio] cache rebuild failed:", err),
  });

  function getStudioCache(): StudioCacheValue {
    return studioCache.get();
  }

  function getTypeSafe(id: string): ContentTypeRuntime | null {
    try {
      return project.getType(id);
    } catch {
      return null;
    }
  }

  /**
   * Batched status-dots renderer for a whole collection page. The per-entry
   * `documentStatus` re-reads the EN file from disk, re-parses it, re-hashes it,
   * and issues one point query — per locale (×15 here). For a 600-doc type
   * that is ~9k disk reads + ~9k queries + ~9k hashes on a single page.
   *
   * Instead we do it once per type: pull every translation row for the type in a
   * single query and index it by (enSlug, locale), and compute each entry's
   * current EN hash once from the already-cached `type.list()` document (no disk
   * read). The returned closure is then a pure in-memory lookup per entry.
   */
  function batchedStatusDots(
    db: ReturnType<typeof openStore>,
    type: ContentTypeRuntime,
  ): (enSlug: string) => string {
    // Non-translatable types have no per-locale status; the collection browser
    // suppresses the status column, so never compute dots for them.
    if (!isTypeTranslatable(type.config)) return () => "";
    const targetLocales = config.locales.filter((l) => l !== config.defaultLocale);

    // One query for the whole type; index rows by "enSlug\x00locale".
    const rowByKey = new Map<string, { en_hash: string }>();
    for (const row of listTranslationsForType(db, type.id)) {
      rowByKey.set(`${row.en_slug}\u0000${row.locale}`, { en_hash: row.en_hash });
    }

    // Current EN hash per entry, computed once from cached docs (no disk read).
    const enHashBySlug = new Map<string, string>();
    for (const doc of type.list() as ScribeDocument[]) {
      const payload = getTranslatablePayload(doc, type.config);
      enHashBySlug.set(doc.enSlug, computeTranslationEnHash(payload.frontmatter, payload.body));
    }

    return (enSlug: string): string => {
      const currentEnHash = enHashBySlug.get(enSlug);
      return targetLocales
        .map((locale) => {
          let status: DocStatus;
          if (currentEnHash === undefined) {
            // EN doc not in the cached list (shouldn't happen for a listed entry).
            status = "missing";
          } else {
            const row = rowByKey.get(`${enSlug}\u0000${locale}`);
            if (!row) status = "missing";
            else if (row.en_hash !== currentEnHash) status = "stale";
            else status = "up-to-date";
          }
          return statusDot(status);
        })
        .join("");
    };
  }

  app.get("/", (c) => {
    const db = openStore(config, "readonly");
    const worklist = buildWorklist(config);
    const targetLocaleCount = config.locales.filter((l) => l !== config.defaultLocale).length;
    const rows = project.listTypes().map((type) => {
      const enCount = type.list().length;
      const localeCells = !isTypeTranslatable(type.config)
        ? `<td colspan="${targetLocaleCount}" class="dim">${notTranslatableChip()}</td>`
        : config.locales
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
            <td><a href="/type/${encodePathSegment(type.id)}">${escapeHtml(type.config.label)}</a></td>
            <td class="dim">${escapeHtml(type.id)}</td>
            <td>${docs}</td>
            <td colspan="2">${notTranslatableChip()}</td>
          </tr>`;
          }
          const stale = staleByType.get(type.id) ?? 0;
          const missing = missingByType.get(type.id) ?? 0;
          return `<tr>
            <td><a href="/type/${encodePathSegment(type.id)}">${escapeHtml(type.config.label)}</a></td>
            <td class="dim">${escapeHtml(type.id)}</td>
            <td>${docs}</td>
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
    const bodyView = c.req.query("body") === "preview" ? "preview" : "raw";
    const docExists = makeDocExists(project, config);
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

    // Non-translatable types have only an EN source — no locale switcher noise.
    const tabLocales = isTypeTranslatable(type.config) ? config.locales : [config.defaultLocale];
    const localeTabs = tabLocales
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
        : `<div class="section-head">Body ${bodyToggleFor(locale, false, bodyView === "preview")}</div>${enBodyInner}`;

    if (locale === config.defaultLocale) {
      contentPanel = `<div class="section">
        <div class="section-head">Frontmatter</div>
        <div class="section-body">${renderFrontmatterTable(enDoc.frontmatter as Record<string, unknown>, type.config.schema)}</div>
        ${bodySection}
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
            : `<div class="section-head">Body ${bodyToggleFor(locale, showRaw, bodyView === "preview")}</div>${trBodyInner}`;
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

    const title = docTitleFromFrontmatter(enDoc.frontmatter as Record<string, unknown>, enSlug);
    // Back-refs (frontmatter relations + body ${{relation:...}} tokens) are
    // locale-independent, so the panel shows on every tab.
    const usedByPanel = renderUsedBy(project, typeId, enSlug, getStudioCache().backRefs);
    const html = `<div class="toolbar">
        <a href="/">Overview</a><span class="sep">›</span>
        <a href="/type/${encodePathSegment(typeId)}">${escapeHtml(type.config.label)}</a><span class="sep">›</span>
        <span>${escapeHtml(enSlug)}</span>
      </div>
      <div class="tabs">${localeTabs}</div>
      ${metaPanel}
      ${contentPanel}
      ${usedByPanel}
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

  // ------------------------------------------------------------------
  // Content management surfaces (read-only)
  // ------------------------------------------------------------------

  // Traversal-safe asset preview: maps a web path onto the configured assets
  // dir and streams the SOURCE file (never the site's publicPath URL).
  app.get("/asset", (c) => {
    const webPath = c.req.query("p");
    if (!webPath) return c.text("missing p", 400);
    const resolved = resolveAssetWebPath(config, webPath);
    if (!resolved) return c.text("not found", 404);
    const info = statAsset(resolved.absPath, webPath);
    if (!info.exists) return c.text("not found", 404);
    try {
      const buf = fs.readFileSync(resolved.absPath);
      const body = new Uint8Array(buf);
      return c.body(body, 200, {
        "Content-Type": contentTypeForPath(webPath),
        "Cache-Control": "no-cache",
      });
    } catch {
      return c.text("not found", 404);
    }
  });

  // Collection browser (table / gallery + field filters).
  app.get("/types/:typeId", (c) => {
    const typeId = c.req.param("typeId");
    const type = getTypeSafe(typeId);
    const cache = getStudioCache();
    if (!type) {
      return c.html(
        renderLayout("Not found", `<div class="toolbar">Unknown type</div>`, project, {
          typeBadges: cache.typeBadges,
        }),
        404,
      );
    }
    const db = openStore(config, "readonly");
    // Precompute status dots for the whole page in one query + one hash pass,
    // then hand the renderer a pure in-memory lookup per entry.
    const statusDotsFor = batchedStatusDots(db, type);
    const html = renderCollectionBrowser(
      {
        project,
        config,
        type,
        buckets: cache.buckets,
        statusDots: (_tid, enSlug) => statusDotsFor(enSlug),
      },
      (key) => c.req.query(key),
    );
    db.close();
    return c.html(
      renderLayout(type.config.label, html, project, {
        activeTypeId: typeId,
        typeBadges: cache.typeBadges,
      }),
    );
  });

  // Entry inspector.
  app.get("/types/:typeId/:enSlug", (c) => {
    const typeId = c.req.param("typeId");
    const enSlug = c.req.param("enSlug");
    const locale = c.req.query("locale") ?? config.defaultLocale;
    const type = getTypeSafe(typeId);
    const cache = getStudioCache();
    if (!type) {
      return c.html(
        renderLayout("Not found", `<div class="toolbar">Unknown type</div>`, project, {
          typeBadges: cache.typeBadges,
        }),
        404,
      );
    }
    const enDoc = readEnDocument(config, type.config, enSlug);
    if (!enDoc) {
      return c.html(
        renderLayout(
          "Not found",
          `<div class="toolbar">Not found</div><p class="dim" style="padding:12px">${escapeHtml(enSlug)}</p>`,
          project,
          { activeTypeId: typeId, typeBadges: cache.typeBadges },
        ),
        404,
      );
    }

    const db = openStore(config, "readonly");

    // Locale tabs reuse the existing status-dot component. Non-translatable types
    // have only an EN source, so we skip the per-locale tabs entirely.
    const tabLocales = isTypeTranslatable(type.config) ? config.locales : [config.defaultLocale];
    const localeTabs = tabLocales
      .map((loc) => {
        const { status } = documentStatus(config, db, type, enSlug, loc);
        const active = loc === locale ? " active" : "";
        const href = `/types/${encodePathSegment(typeId)}/${encodePathSegment(enSlug)}?locale=${encodePathSegment(loc)}`;
        return `<a class="tab${active}" href="${href}">${escapeHtml(loc)} ${statusDot(status)}</a>`;
      })
      .join("");

    // Merged locale frontmatter (structural from EN + translatable from store).
    let localeFrontmatter: Record<string, unknown> | null = null;
    let isFallback = false;
    if (locale !== config.defaultLocale) {
      const translation = getTranslation(db, typeId, enSlug, locale);
      if (translation) {
        const rawFm = JSON.parse(translation.frontmatter_json) as Record<string, unknown>;
        localeFrontmatter = mergeStructuralOntoLocale(
          rawFm,
          enDoc.frontmatter as Record<string, unknown>,
          type.config.schema,
        );
      } else {
        isFallback = true;
      }
    }
    db.close();

    const bodyView = c.req.query("body") === "preview" ? "preview" : "raw";

    // Prev/next in the collection's default order (same order the table uses).
    // Preserve the current locale + body query params on the target hrefs.
    const carry = new URLSearchParams();
    if (locale !== config.defaultLocale) carry.set("locale", locale);
    if (bodyView === "preview") carry.set("body", "preview");
    const qs = carry.toString();
    const suffix = qs ? `?${qs}` : "";
    const orderedSlugs = type.list().map((d) => d.enSlug);
    const currentIndex = orderedSlugs.indexOf(enSlug);
    const linkFor = (slug: string) =>
      `/types/${encodePathSegment(typeId)}/${encodePathSegment(slug)}${suffix}`;
    const prev =
      currentIndex > 0
        ? { href: linkFor(orderedSlugs[currentIndex - 1]!), slug: orderedSlugs[currentIndex - 1]! }
        : null;
    const next =
      currentIndex >= 0 && currentIndex < orderedSlugs.length - 1
        ? { href: linkFor(orderedSlugs[currentIndex + 1]!), slug: orderedSlugs[currentIndex + 1]! }
        : null;
    const deleteHref = `/types/${encodePathSegment(typeId)}/${encodePathSegment(enSlug)}/delete`;

    const ctx: InspectorContext = {
      project,
      config,
      type,
      enSlug,
      locale,
      enDoc,
      localeFrontmatter,
      isFallback,
      backRefs: cache.backRefs,
      buckets: cache.buckets,
      localeTabs,
      bodyView,
      prev,
      next,
      deleteHref,
    };
    const title = docTitleFromFrontmatter(enDoc.frontmatter as Record<string, unknown>, enSlug);
    return c.html(
      renderLayout(title, renderEntryInspector(ctx), project, {
        activeTypeId: typeId,
        typeBadges: cache.typeBadges,
      }),
    );
  });

  // Entry deletion: confirmation page (GET) + execution (POST). The studio's
  // first mutating route; it stays a localhost dev tool (POST-only, no CSRF).
  app.get("/types/:typeId/:enSlug/delete", (c) => {
    const typeId = c.req.param("typeId");
    const enSlug = c.req.param("enSlug");
    const cache = getStudioCache();
    const type = getTypeSafe(typeId);
    if (!type) {
      return c.html(
        renderLayout("Not found", `<div class="toolbar">Unknown type</div>`, project, {
          typeBadges: cache.typeBadges,
        }),
        404,
      );
    }
    let plan: DeletionPlan;
    try {
      plan = buildDeletionPlan(project, typeId, enSlug);
    } catch {
      return c.html(
        renderLayout(
          "Not found",
          `<div class="toolbar">Not found</div><p class="dim" style="padding:12px">${escapeHtml(enSlug)}</p>`,
          project,
          { activeTypeId: typeId, typeBadges: cache.typeBadges },
        ),
        404,
      );
    }
    const cancelHref = `/types/${encodePathSegment(typeId)}/${encodePathSegment(enSlug)}`;
    const postHref = `/types/${encodePathSegment(typeId)}/${encodePathSegment(enSlug)}/delete`;
    const html = renderDeletionPlanPage(project, plan, { typeId, enSlug, cancelHref, postHref });
    return c.html(
      renderLayout(`Delete ${enSlug}`, html, project, {
        activeTypeId: typeId,
        typeBadges: cache.typeBadges,
      }),
    );
  });

  app.post("/types/:typeId/:enSlug/delete", async (c) => {
    const typeId = c.req.param("typeId");
    const enSlug = c.req.param("enSlug");
    const type = getTypeSafe(typeId);
    if (!type) return c.text("Unknown type", 404);
    let plan: DeletionPlan;
    try {
      plan = buildDeletionPlan(project, typeId, enSlug);
    } catch {
      return c.text("Not found", 404);
    }
    if (isPlanBlocked(plan)) {
      // A blocked plan can never be executed; bounce back to the confirmation page.
      return c.redirect(
        `/types/${encodePathSegment(typeId)}/${encodePathSegment(enSlug)}/delete`,
        303,
      );
    }
    try {
      executeDeletionPlan(project, plan);
    } catch (err) {
      console.error("[scribe:studio] deletion failed:", err);
      return c.text("Deletion failed", 500);
    }
    // Refresh derived data so the collection view reflects the deletion at once.
    studioCache.invalidate();
    studioCache.get();
    return c.redirect(`/types/${encodePathSegment(typeId)}`, 303);
  });

  // Global full-text search (EN content).
  app.get("/search", (c) => {
    const q = c.req.query("q") ?? "";
    const cache = getStudioCache();
    const html = renderSearchPage(project, q);
    return c.html(
      renderLayout("Search", html, project, {
        activeNav: "search",
        typeBadges: cache.typeBadges,
        searchQuery: q,
      }),
    );
  });

  // Asset browser.
  app.get("/assets", (c) => {
    const cache = getStudioCache();
    const html = renderAssetBrowser(config, cache.assetRefs);
    return c.html(
      renderLayout("Assets", html, project, {
        activeNav: "assets",
        typeBadges: cache.typeBadges,
      }),
    );
  });

  app.get("/*", (c) => {
    const asset = serveStudioAsset(config, c.req.path);
    if (!asset) {
      return c.html(renderLayout("Not found", `<div class="toolbar">Not found</div>`, project), 404);
    }
    return c.body(asset.body, 200, {
      "Content-Type": asset.contentType,
      "Cache-Control": "no-cache",
    });
  });

  const port = options.port ?? 3600;
  const host = options.host ?? "127.0.0.1";
  serve({ fetch: app.fetch, port, hostname: host }, () => {
    console.log(`Scribe studio listening on http://${host}:${port}`);
    // Warm the derived-data cache (back-refs, asset graph, validation report)
    // and every content loader at boot, off the request path. The full build
    // parses ~all EN docs and validates every MDX body — multiple seconds on a
    // large project. Without this, that cost is scheduled by the *first* request
    // and, running synchronously on the event loop, blocks whichever request
    // arrives next (observed: a ~4s stall on the second navigation). Priming it
    // here means the build has usually finished before the first click, so
    // navigations are warm. Fire-and-forget: `studioCache.get()` returns the
    // placeholder immediately and schedules the real build via its own
    // scheduler, which also calls `type.list()` for every type and so warms all
    // loaders. Errors surface through the cache's `onError`.
    try {
      studioCache.get();
    } catch (err) {
      console.error("[scribe:studio] boot warm-up failed:", err);
    }
  });
}
