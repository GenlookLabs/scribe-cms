import type { z } from "zod";
import type {
  ContentTypeRuntime,
  ScribeConfig,
  ScribeDocument,
  ScribeProject,
} from "../src/core/types.js";
import { isRoutableType } from "../src/i18n/build-url.js";
import { isTypeTranslatable } from "../src/core/introspect-schema.js";
import type { ValidateIssue } from "../src/validate/validate-project.js";
import { assetPreviewUrl, encodePathSegment, escapeHtml } from "./shared.js";
import {
  backRefsFor,
  filterFieldsFor,
  introspectStudioFields,
  keyFieldsFor,
  primaryAssetField,
  valueAtPath,
  type BackRefIndex,
  type FilterFieldMeta,
  type StudioFieldMeta,
} from "./introspect-fields.js";
import { readImageDimensions, resolveAssetWebPath, statAsset } from "./asset-serve.js";
import { renderMdxApprox } from "./mdx-preview.js";

// ---------------------------------------------------------------------------
// Validation buckets
// ---------------------------------------------------------------------------

export interface ValidationBuckets {
  /** `typeId` → `enSlug` → issues touching that entry (any locale). */
  byEntry: Map<string, Map<string, ValidateIssue[]>>;
  /** `typeId` → issues for that type (aggregate). */
  byType: Map<string, ValidateIssue[]>;
}

export function bucketValidation(issues: ValidateIssue[]): ValidationBuckets {
  const byEntry = new Map<string, Map<string, ValidateIssue[]>>();
  const byType = new Map<string, ValidateIssue[]>();
  for (const issue of issues) {
    if (!issue.contentType) continue;
    const typeList = byType.get(issue.contentType) ?? [];
    typeList.push(issue);
    byType.set(issue.contentType, typeList);
    if (!issue.enSlug) continue;
    let entryMap = byEntry.get(issue.contentType);
    if (!entryMap) {
      entryMap = new Map();
      byEntry.set(issue.contentType, entryMap);
    }
    const list = entryMap.get(issue.enSlug) ?? [];
    list.push(issue);
    entryMap.set(issue.enSlug, list);
  }
  return { byEntry, byType };
}

function countLevels(issues: ValidateIssue[]): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const issue of issues) {
    if (issue.level === "error") errors++;
    else if (issue.level === "warning") warnings++;
  }
  return { errors, warnings };
}

const LEVEL_RANK: Record<string, number> = { error: 0, warning: 1, info: 2 };

/** Level mark for a tooltip row (styled like the count chips). */
function levelMark(level: string): string {
  if (level === "error") return `<span class="vbadge err">✕</span>`;
  if (level === "warning") return `<span class="vbadge warn">!</span>`;
  return `<span class="vbadge info">i</span>`;
}

/** Hover/focus tooltip panel: up to 10 issues (errors first), then a "+N more" row. */
function renderVtipPanel(issues: ValidateIssue[]): string {
  const sorted = [...issues].sort(
    (a, b) => (LEVEL_RANK[a.level] ?? 3) - (LEVEL_RANK[b.level] ?? 3),
  );
  const rows = sorted.slice(0, 10).map((i) => {
    const meta: string[] = [];
    if (i.enSlug) meta.push(`<span class="vmeta">${escapeHtml(i.enSlug)}</span>`);
    if (i.locale) meta.push(`<span class="vmeta">${escapeHtml(i.locale)}</span>`);
    if (i.field) meta.push(`<span class="vmeta">${escapeHtml(i.field)}</span>`);
    const msg = i.message.length > 140 ? i.message.slice(0, 140) + "…" : i.message;
    return `<div class="vrow">${levelMark(i.level)}${meta.join("")}<span class="vmsg">${escapeHtml(msg)}</span></div>`;
  });
  if (issues.length > 10) {
    rows.push(`<div class="vrow more">+${issues.length - 10} more issues</div>`);
  }
  return `<div class="vtip-panel">${rows.join("")}</div>`;
}

/**
 * Error/warning count chips for a bag of issues, wrapped in a CSS-only hover
 * tooltip that lists the individual issues. Empty string when there is nothing
 * error/warning-level to show. Same signature as before, so every call site
 * (sidebar type badges, collection rows, gallery cards, inspector) inherits the
 * tooltip.
 */
export function validationBadge(issues: ValidateIssue[] | undefined): string {
  if (!issues || issues.length === 0) return "";
  const { errors, warnings } = countLevels(issues);
  const chips: string[] = [];
  if (errors > 0) chips.push(`<span class="vbadge err">${errors}✕</span>`);
  if (warnings > 0) chips.push(`<span class="vbadge warn">${warnings}!</span>`);
  if (chips.length === 0) return "";
  return `<span class="vtip" tabindex="0">${chips.join("")}${renderVtipPanel(issues)}</span>`;
}

/** Sidebar aggregate badge (compact) for each type. */
export function typeBadges(buckets: ValidationBuckets): Map<string, string> {
  const out = new Map<string, string>();
  for (const [typeId, issues] of buckets.byType) {
    const badge = validationBadge(issues);
    if (badge) out.set(typeId, ` ${badge}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Value rendering
// ---------------------------------------------------------------------------

function scalarText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  return JSON.stringify(value);
}

function chip(text: string, cls = ""): string {
  return `<span class="chip${cls ? " " + cls : ""}">${escapeHtml(text)}</span>`;
}

/** Neutral chip for a type with nothing to translate (bodyless + no translatable fields). */
export function notTranslatableChip(): string {
  return `<span class="chip nt" title="No translatable fields and no body">not translatable</span>`;
}

/** Neutral chip shown instead of a body section for `body: false` types. */
export function frontmatterOnlyChip(): string {
  return `<span class="chip nt" title="body: false — this type has no MDX body">frontmatter-only</span>`;
}

/** Render a relation value as chips linking to the target entry (red when dangling). */
function relationChips(
  project: ScribeProject,
  field: StudioFieldMeta,
  value: unknown,
): string {
  const target = field.relationTarget;
  if (!target) return "";
  const slugs = Array.isArray(value)
    ? value.filter((s): s is string => typeof s === "string" && s.length > 0)
    : typeof value === "string" && value
      ? [value]
      : [];
  if (slugs.length === 0) return `<span class="dim">—</span>`;
  const targetRuntime = safeGetType(project, target);
  return slugs
    .map((slug) => {
      const exists = targetRuntime ? targetRuntime.get(slug) !== null : false;
      if (!exists) {
        return `<span class="chip rel-bad" title="dangling: no ${escapeHtml(target)} '${escapeHtml(slug)}'">${escapeHtml(slug)} ✕</span>`;
      }
      const href = `/types/${encodePathSegment(target)}/${encodePathSegment(slug)}`;
      return `<span class="chip rel"><a href="${href}">${escapeHtml(slug)}</a></span>`;
    })
    .join("");
}

function safeGetType(project: ScribeProject, id: string): ContentTypeRuntime | null {
  try {
    return project.getType(id);
  } catch {
    return null;
  }
}

/** Compact cell rendering for a key field in the entry table. */
function keyFieldCell(project: ScribeProject, field: StudioFieldMeta, frontmatter: Record<string, unknown>): string {
  const value = valueAtPath(frontmatter, field.path);
  if (field.kind === "relation") return relationChips(project, field, value);
  if (field.enumOptions) {
    const text = scalarText(value);
    return text ? chip(text) : `<span class="dim">—</span>`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return `<span class="dim">—</span>`;
    return value.slice(0, 4).map((v) => chip(scalarText(v))).join("") + (value.length > 4 ? " …" : "");
  }
  const text = scalarText(value);
  if (!text) return `<span class="dim">—</span>`;
  return escapeHtml(text.length > 60 ? text.slice(0, 60) + "…" : text);
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export interface ActiveFilters {
  [key: string]: string;
}

/** Read active filter values from query params (only for the type's filterable fields). */
export function readFilters(
  filterFields: FilterFieldMeta[],
  query: (key: string) => string | undefined,
): ActiveFilters {
  const out: ActiveFilters = {};
  for (const f of filterFields) {
    const raw = query(f.key);
    if (raw !== undefined && raw !== "") out[f.key] = raw;
  }
  return out;
}

/** Apply active filters to a document list. Generic per filter kind. */
export function applyFilters(
  docs: ScribeDocument[],
  filterFields: FilterFieldMeta[],
  active: ActiveFilters,
): ScribeDocument[] {
  const byKey = new Map(filterFields.map((f) => [f.key, f]));
  return docs.filter((doc) => {
    const frontmatter = doc.frontmatter as Record<string, unknown>;
    for (const [key, wanted] of Object.entries(active)) {
      const field = byKey.get(key);
      if (!field) continue;
      const value = valueAtPath(frontmatter, [key]);
      if (field.kind === "boolean") {
        const actual = value === true ? "true" : "false";
        if (actual !== wanted) return false;
      } else if (field.kind === "relation") {
        if (Array.isArray(value)) {
          if (!value.includes(wanted)) return false;
        } else if (value !== wanted) {
          return false;
        }
      } else if (field.kind === "string") {
        if (typeof value !== "string" || !value.toLowerCase().includes(wanted.toLowerCase())) {
          return false;
        }
      } else {
        // enum
        if (scalarText(value) !== wanted) return false;
      }
    }
    return true;
  });
}

function renderFilterBar(
  project: ScribeProject,
  typeId: string,
  filterFields: FilterFieldMeta[],
  active: ActiveFilters,
  view: "table" | "gallery",
  hasGallery: boolean,
): string {
  if (filterFields.length === 0 && !hasGallery) return "";
  const controls = filterFields
    .map((f) => {
      const current = active[f.key] ?? "";
      if (f.kind === "enum") {
        const opts = ["", ...(f.enumOptions ?? [])]
          .map(
            (o) =>
              `<option value="${escapeHtml(o)}"${o === current ? " selected" : ""}>${o === "" ? "any" : escapeHtml(o)}</option>`,
          )
          .join("");
        return `<label>${escapeHtml(f.key)} <select name="${escapeHtml(f.key)}">${opts}</select></label>`;
      }
      if (f.kind === "relation" && f.relationTarget) {
        const targetRuntime = safeGetType(project, f.relationTarget);
        const slugs = targetRuntime ? targetRuntime.list().map((d) => d.slug) : [];
        const opts = ["", ...slugs]
          .map(
            (o) =>
              `<option value="${escapeHtml(o)}"${o === current ? " selected" : ""}>${o === "" ? "any" : escapeHtml(o)}</option>`,
          )
          .join("");
        return `<label>${escapeHtml(f.key)} <select name="${escapeHtml(f.key)}">${opts}</select></label>`;
      }
      if (f.kind === "boolean") {
        const opts = [
          ["", "any"],
          ["true", "true"],
          ["false", "false"],
        ]
          .map(
            ([val, label]) =>
              `<option value="${val}"${val === current ? " selected" : ""}>${label}</option>`,
          )
          .join("");
        return `<label>${escapeHtml(f.key)} <select name="${escapeHtml(f.key)}">${opts}</select></label>`;
      }
      // string
      return `<label>${escapeHtml(f.key)} <input type="text" name="${escapeHtml(f.key)}" value="${escapeHtml(current)}" placeholder="contains…" /></label>`;
    })
    .join("");

  const viewToggle = hasGallery
    ? `<span class="viewtoggle">
        <a href="${buildTypeUrl(typeId, active, "table")}" class="${view === "table" ? "active" : ""}">table</a>
        <a href="${buildTypeUrl(typeId, active, "gallery")}" class="${view === "gallery" ? "active" : ""}">gallery</a>
      </span>`
    : "";

  // The view field is carried in a hidden input so it survives filter submits.
  const viewHidden = hasGallery ? `<input type="hidden" name="view" value="${view}" />` : "";

  return `<form class="filters" method="get" onchange="this.submit()">
    ${controls}
    ${viewHidden}
    ${viewToggle}
    <a class="reset" href="/types/${encodePathSegment(typeId)}${view === "gallery" ? "?view=gallery" : ""}">reset</a>
  </form>`;
}

function buildTypeUrl(typeId: string, active: ActiveFilters, view: "table" | "gallery"): string {
  const params = new URLSearchParams(active);
  if (view === "gallery") params.set("view", "gallery");
  const qs = params.toString();
  return `/types/${encodePathSegment(typeId)}${qs ? "?" + qs : ""}`;
}

// ---------------------------------------------------------------------------
// Collection browser
// ---------------------------------------------------------------------------

export interface CollectionContext {
  project: ScribeProject;
  config: ScribeConfig;
  type: ContentTypeRuntime;
  buckets: ValidationBuckets;
  /** Per (type,slug,locale) status dots renderer supplied by the server. */
  statusDots: (typeId: string, enSlug: string) => string;
}

export function renderCollectionBrowser(
  ctx: CollectionContext,
  query: (key: string) => string | undefined,
): string {
  const { project, type, buckets } = ctx;
  const schema = type.config.schema as z.ZodTypeAny;
  const filterFields = filterFieldsFor(schema);
  const keyFields = keyFieldsFor(schema);
  const primaryAsset = primaryAssetField(schema);
  const hasGallery = Boolean(primaryAsset);
  const view: "table" | "gallery" = query("view") === "gallery" && hasGallery ? "gallery" : "table";
  const active = readFilters(filterFields, query);

  const allDocs = type.list() as ScribeDocument[];
  const docs = applyFilters(allDocs, filterFields, active);
  const entryBucket = buckets.byEntry.get(type.id);

  const filterBar = renderFilterBar(project, type.id, filterFields, active, view, hasGallery);

  const ntMarker = isTypeTranslatable(type.config) ? "" : ` ${notTranslatableChip()}`;
  const toolbar = `<div class="toolbar">
      <a href="/">Overview</a><span class="sep">›</span>${escapeHtml(type.config.label)}${ntMarker}
      <span class="dim"> · ${docs.length}${docs.length !== allDocs.length ? ` / ${allDocs.length}` : ""} entries</span>
    </div>`;

  const body =
    view === "gallery"
      ? renderGallery(ctx, docs, keyFields, primaryAsset!, entryBucket)
      : renderTable(ctx, docs, keyFields, entryBucket);

  return `${toolbar}${filterBar}${body}`;
}

function renderTable(
  ctx: CollectionContext,
  docs: ScribeDocument[],
  keyFields: StudioFieldMeta[],
  entryBucket: Map<string, ValidateIssue[]> | undefined,
): string {
  const { project, type, statusDots } = ctx;
  // Non-translatable types (bodyless, no translatable fields) carry no per-locale
  // status: suppress the "Locales" column of status dots entirely.
  const showStatus = isTypeTranslatable(type.config);
  const keyHeaders = keyFields.map((f) => `<th>${escapeHtml(f.path.join("."))}</th>`).join("");
  const rows = docs
    .map((doc) => {
      const frontmatter = doc.frontmatter as Record<string, unknown>;
      const href = `/types/${encodePathSegment(type.id)}/${encodePathSegment(doc.enSlug)}`;
      const keyCells = keyFields
        .map((f) => `<td>${keyFieldCell(project, f, frontmatter)}</td>`)
        .join("");
      const badge = validationBadge(entryBucket?.get(doc.enSlug));
      const statusCell = showStatus
        ? `<td><span class="dots">${statusDots(type.id, doc.enSlug)}</span></td>`
        : "";
      return `<tr>
        <td class="mono"><a href="${href}">${escapeHtml(doc.slug)}</a>${badge}</td>
        ${keyCells}
        ${statusCell}
      </tr>`;
    })
    .join("");
  const colspan = 1 + keyFields.length + (showStatus ? 1 : 0);
  const statusHeader = showStatus ? "<th>Locales</th>" : "";
  return `<table class="data">
      <thead><tr><th>Slug</th>${keyHeaders}${statusHeader}</tr></thead>
      <tbody>${rows || `<tr><td colspan="${colspan}" class="dim">No matching entries</td></tr>`}</tbody>
    </table>`;
}

function renderGallery(
  ctx: CollectionContext,
  docs: ScribeDocument[],
  keyFields: StudioFieldMeta[],
  primaryAsset: { path: string[]; assetTemplate?: string },
  entryBucket: Map<string, ValidateIssue[]> | undefined,
): string {
  const { project, config, type } = ctx;
  const cards = docs
    .map((doc) => {
      const frontmatter = doc.frontmatter as Record<string, unknown>;
      const href = `/types/${encodePathSegment(type.id)}/${encodePathSegment(doc.enSlug)}`;
      const webPath = sourceAssetValue(frontmatter, primaryAsset, doc.enSlug);
      let thumb = `<div class="thumb"><span class="noimg">no image</span></div>`;
      if (webPath) {
        const resolved = resolveAssetWebPath(config, webPath);
        if (resolved && statAsset(resolved.absPath, webPath).exists) {
          thumb = `<div class="thumb"><img loading="lazy" src="${assetPreviewUrl(webPath)}" alt="${escapeHtml(doc.slug)}" /></div>`;
        } else {
          thumb = `<div class="thumb"><span class="noimg">missing file</span></div>`;
        }
      }
      const keyLine = keyFields
        .filter((f) => f.kind === "relation" || f.enumOptions)
        .slice(0, 3)
        .map((f) => keyFieldCell(project, f, frontmatter))
        .join(" ");
      const badge = validationBadge(entryBucket?.get(doc.enSlug));
      return `<a class="gcard" href="${href}">
        ${thumb}
        <div class="body">
          <span class="gslug">${escapeHtml(doc.slug)}${badge}</span>
          <span class="gkey">${keyLine}</span>
        </div>
      </a>`;
    })
    .join("");
  return `<div class="gallery">${cards || `<span class="dim" style="padding:12px">No matching entries</span>`}</div>`;
}

/** SOURCE (unresolved) asset value for a field on an entry, materializing templates. */
function sourceAssetValue(
  frontmatter: Record<string, unknown>,
  field: { path: string[]; assetTemplate?: string },
  enSlug: string,
): string | undefined {
  // Only handle top-level (non-`*`) asset fields for the primary thumbnail.
  if (field.path.includes("*")) return undefined;
  const value = valueAtPath(frontmatter, field.path);
  if (typeof value === "string" && value) return value;
  if (value === undefined && field.assetTemplate) {
    return field.assetTemplate.split("{slug}").join(enSlug);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Entry inspector
// ---------------------------------------------------------------------------

export interface InspectorContext {
  project: ScribeProject;
  config: ScribeConfig;
  type: ContentTypeRuntime;
  enSlug: string;
  locale: string;
  enDoc: ScribeDocument;
  /** Locale frontmatter (already merged for display) or null when EN / untranslated. */
  localeFrontmatter: Record<string, unknown> | null;
  /** True when the requested locale has no stored translation (EN fallback shown). */
  isFallback: boolean;
  backRefs: BackRefIndex;
  buckets: ValidationBuckets;
  /** Locale tabs HTML from the server (reusing existing status dots). */
  localeTabs: string;
  /** Which body tab to show: raw MDX source (default) or the rendered approximation. */
  bodyView?: "raw" | "preview";
}

export function renderEntryInspector(ctx: InspectorContext): string {
  const { project, config, type, enSlug, locale, enDoc } = ctx;
  const schema = type.config.schema as z.ZodTypeAny;
  const fields = introspectStudioFields(schema);

  const displayFm =
    locale === config.defaultLocale || !ctx.localeFrontmatter
      ? (enDoc.frontmatter as Record<string, unknown>)
      : ctx.localeFrontmatter;
  const enFm = enDoc.frontmatter as Record<string, unknown>;

  const fieldRows = fields
    .filter((f) => !f.path.includes("*")) // flat top-level + nested-object leaves; skip array item fields in the summary
    .map((f) => renderFieldRow(ctx, f, displayFm, enFm))
    .join("");

  const entryIssues = ctx.buckets.byEntry.get(type.id)?.get(enSlug) ?? [];
  const issuesPanel = renderIssuesPanel(entryIssues);
  const usedByPanel = renderUsedBy(project, type.id, enSlug, ctx.backRefs);

  // Body: two tabs — Raw MDX (default) and a rendered approximation (Preview).
  // The translation store body isn't surfaced here; the EN source body is shown
  // for every locale tab (the existing translation dashboard covers per-locale
  // bodies at /type/:id/doc/:enSlug). Bodyless types (`body: false`) have no MDX
  // body at all — show a "frontmatter-only" chip instead.
  const bodyPanel =
    type.config.body === false
      ? `<div class="section">
      <div class="section-head">Body</div>
      <p class="dim" style="padding:6px 12px">${frontmatterOnlyChip()}</p>
    </div>`
      : renderBodyPanel(ctx);

  const viewOnSite = renderViewOnSite(type, enSlug, locale);

  const toolbar = `<div class="toolbar">
      <a href="/">Overview</a><span class="sep">›</span>
      <a href="/types/${encodePathSegment(type.id)}">${escapeHtml(type.config.label)}</a><span class="sep">›</span>
      <span>${escapeHtml(enSlug)}</span>
      <span class="spacer"></span>
      ${viewOnSite}
    </div>`;

  return `${toolbar}
    <div class="tabs">${ctx.localeTabs}</div>
    ${issuesPanel}
    <div class="section">
      <div class="section-head">Fields</div>
      <div class="section-body"><table class="kv"><tbody>${fieldRows}</tbody></table></div>
    </div>
    ${usedByPanel}
    ${bodyPanel}`;
}

/** Body section with Raw / Preview tabs. Raw is the default (query param `body=preview`). */
function renderBodyPanel(ctx: InspectorContext): string {
  const preview = ctx.bodyView === "preview";
  const base = `/types/${encodePathSegment(ctx.type.id)}/${encodePathSegment(ctx.enSlug)}`;
  const locPart = `locale=${encodePathSegment(ctx.locale)}`;
  const rawHref = `${base}?${locPart}`;
  const previewHref = `${base}?${locPart}&body=preview`;
  const tabs = `<span class="bodytabs">
      <a href="${rawHref}" class="${preview ? "" : "active"}">Raw</a>
      <a href="${previewHref}" class="${preview ? "active" : ""}">Preview</a>
    </span>`;
  const content = preview
    ? `<div class="mdx-preview">${renderMdxApprox(ctx.enDoc.content)}</div>`
    : `<pre class="code">${escapeHtml(ctx.enDoc.content)}</pre>`;
  return `<div class="section">
    <div class="section-head">Body ${tabs}</div>
    ${content}
  </div>`;
}

function fieldFlag(kind: StudioFieldMeta["kind"]): string {
  if (kind === "translatable") return `<span class="flag t" title="Translatable">T</span>`;
  if (kind === "relation") return `<span class="flag s" title="Relation">R</span>`;
  if (kind === "asset") return `<span class="flag s" title="Asset">A</span>`;
  return `<span class="flag s" title="Structural">S</span>`;
}

function renderFieldRow(
  ctx: InspectorContext,
  field: StudioFieldMeta,
  displayFm: Record<string, unknown>,
  enFm: Record<string, unknown>,
): string {
  const { project, config } = ctx;
  const key = field.path.join(".");
  // Relations/assets are structural — always read from EN (merged) source.
  const structural = field.kind === "relation" || field.kind === "asset";
  const value = valueAtPath(structural ? enFm : displayFm, field.path);

  let cell: string;
  if (field.kind === "relation") {
    cell = relationChips(project, field, value);
  } else if (field.kind === "asset") {
    cell = renderAssetCell(config, field, valueAtPath(enFm, field.path), ctx.enSlug);
  } else if (field.kind === "translatable") {
    const enValue = valueAtPath(enFm, field.path);
    const localeMissing =
      ctx.locale !== config.defaultLocale &&
      (value === undefined || value === null || JSON.stringify(value) === JSON.stringify(enValue));
    const text = scalarText(value);
    const shown = Array.isArray(value)
      ? value.length
        ? value.map((v) => chip(scalarText(v))).join("")
        : `<span class="dim">—</span>`
      : text
        ? escapeHtml(text)
        : `<span class="dim">—</span>`;
    const fallbackTag =
      ctx.locale !== config.defaultLocale && localeMissing
        ? ` <span class="tag">EN fallback</span>`
        : "";
    cell = `${shown}${fallbackTag}`;
  } else {
    const shown = Array.isArray(value)
      ? value.length
        ? value.map((v) => chip(scalarText(v))).join("")
        : `<span class="dim">—</span>`
      : value !== undefined && value !== null && value !== ""
        ? escapeHtml(scalarText(value))
        : `<span class="dim">—</span>`;
    cell = shown;
  }

  return `<tr>
    <td class="k">${fieldFlag(field.kind)}${escapeHtml(key)}</td>
    <td class="v">${cell}</td>
  </tr>`;
}

function renderAssetCell(
  config: ScribeConfig,
  field: StudioFieldMeta,
  rawValue: unknown,
  enSlug: string,
): string {
  let webPath: string | undefined;
  if (typeof rawValue === "string" && rawValue) webPath = rawValue;
  else if (rawValue === undefined && field.assetTemplate) {
    webPath = field.assetTemplate.split("{slug}").join(enSlug);
  }
  if (!webPath) {
    if (field.assetOptional) return `<span class="dim">—</span>`;
    return `<span class="vbadge err">missing value</span>`;
  }

  const resolved = resolveAssetWebPath(config, webPath);
  const info = resolved ? statAsset(resolved.absPath, webPath) : null;
  const previewSrc = assetPreviewUrl(webPath);

  if (!resolved || !info?.exists) {
    return `<div class="asset-preview">
      <div class="frame"><span class="noimg">missing</span></div>
      <div class="info">
        <div class="mono">${escapeHtml(webPath)}</div>
        <span class="vbadge err">file not found</span>
      </div>
    </div>`;
  }

  const dims = resolved ? readImageDimensions(resolved.absPath) : null;
  const sizeKB = info.sizeBytes !== undefined ? Math.round(info.sizeBytes / 1024) : undefined;
  const oversized =
    field.assetMaxKB !== undefined && sizeKB !== undefined && sizeKB > field.assetMaxKB;
  const ext = webPath.split(".").pop()?.toLowerCase();
  const drift =
    field.assetFormats && field.assetFormats.length > 0 && ext && !field.assetFormats.includes(ext);

  const badges = [
    oversized
      ? `<span class="vbadge warn">over ${field.assetMaxKB}KB</span>`
      : "",
    drift ? `<span class="vbadge warn">format .${escapeHtml(ext!)}</span>` : "",
  ].join("");

  return `<div class="asset-preview">
    <div class="frame"><img loading="lazy" src="${previewSrc}" alt="asset" /></div>
    <div class="info">
      <div class="mono">${escapeHtml(webPath)}</div>
      <div class="dim">${sizeKB !== undefined ? `${sizeKB} KB` : "size ?"}${dims ? ` · ${dims.width}×${dims.height}` : ""}</div>
      ${badges}
    </div>
  </div>`;
}

function renderIssuesPanel(issues: ValidateIssue[]): string {
  if (issues.length === 0) return "";
  const rows = issues
    .map(
      (i) =>
        `<tr>
          <td>${validationBadge([i])}</td>
          <td class="mono">${escapeHtml(i.locale ?? "en")}</td>
          <td class="mono">${escapeHtml(i.field ?? "")}</td>
          <td>${escapeHtml(i.message)}</td>
        </tr>`,
    )
    .join("");
  return `<div class="section">
    <div class="section-head">Validation</div>
    <table class="data"><tbody>${rows}</tbody></table>
  </div>`;
}

function renderUsedBy(
  project: ScribeProject,
  typeId: string,
  enSlug: string,
  backRefs: BackRefIndex,
): string {
  const refs = backRefsFor(backRefs, typeId, enSlug);
  if (refs.length === 0) {
    return `<div class="section">
      <div class="section-head">Used by</div>
      <p class="dim" style="padding:6px 12px">Nothing references this entry.</p>
    </div>`;
  }
  const rows = refs
    .map((ref) => {
      const refType = safeGetType(project, ref.typeId);
      const label = refType ? refType.config.label : ref.typeId;
      const href = `/types/${encodePathSegment(ref.typeId)}/${encodePathSegment(ref.enSlug)}`;
      return `<tr>
        <td>${escapeHtml(label)}</td>
        <td class="mono"><a href="${href}">${escapeHtml(ref.enSlug)}</a></td>
        <td class="mono dim">${escapeHtml(ref.field)}</td>
      </tr>`;
    })
    .join("");
  return `<div class="section">
    <div class="section-head">Used by <span class="dim">· ${refs.length}</span></div>
    <table class="data">
      <thead><tr><th>Type</th><th>Entry</th><th>Field</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function renderViewOnSite(
  type: ContentTypeRuntime,
  enSlug: string,
  locale: string,
): string {
  if (!isRoutableType(type.config)) return "";
  try {
    const path = type.url(enSlug, locale);
    return `<a href="${escapeHtml(path)}" title="Path on site" class="dim">${escapeHtml(path)} ↗</a>`;
  } catch {
    return "";
  }
}
