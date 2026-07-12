import type { z } from "zod";
import yaml from "js-yaml";
import {
  getAssetMeta,
  getFieldDescription,
  getFieldKind,
  getRelationTarget,
  peelOptionalWrappers,
  type AssetMeta,
} from "../src/core/field.js";
import type { ContentTypeRuntime, ScribeConfig, ScribeProject } from "../src/core/types.js";
import {
  assetPreviewUrl,
  docTitleFromFrontmatter,
  encodePathSegment,
  escapeHtml,
} from "./shared.js";

/**
 * Studio entry-form rendering. Turns a content type's Zod schema into an HTML
 * form (one control per top-level field) for the create/edit routes. Everything
 * is derived from the schema — never from a content-type id — mirroring the
 * read-only introspection in `introspect-fields.ts`.
 *
 * The form is a plain multipart POST; there is no client framework. The only
 * client JS is a few inline lines that slugify the first translatable string
 * field into the slug input and live-update templated asset destination hints.
 */

// ---------------------------------------------------------------------------
// Form-field names (shared contract between rendering and `entry-write.ts`)
// ---------------------------------------------------------------------------

/** Scalar / enum / relation / boolean field values. */
export const FIELD_PREFIX = "f:";
/** File uploads (single or multiple asset fields). */
export const FILE_PREFIX = "file:";
/** Raw YAML textareas (structural object / array escape hatch). */
export const YAML_PREFIX = "yaml:";
/** "Remove this existing item" checkboxes on a multiple asset field. `remove:{key}:{index}`. */
export const REMOVE_PREFIX = "remove:";
/** The MDX body textarea. */
export const BODY_FIELD = "body";
/** The slug input. */
export const SLUG_FIELD = "slug";

export function fieldName(key: string): string {
  return `${FIELD_PREFIX}${key}`;
}
export function fileName(key: string): string {
  return `${FILE_PREFIX}${key}`;
}
export function yamlName(key: string): string {
  return `${YAML_PREFIX}${key}`;
}
export function removeName(key: string, index: number): string {
  return `${REMOVE_PREFIX}${key}:${index}`;
}

// ---------------------------------------------------------------------------
// Schema → form-field descriptors
// ---------------------------------------------------------------------------

export type FormFieldKind =
  | "text"
  | "number"
  | "boolean"
  | "enum"
  | "relation"
  | "asset"
  | "yaml";

export interface FormField {
  key: string;
  kind: FormFieldKind;
  /** The field may be omitted (optional / defaulted / nullable). */
  optional: boolean;
  /** Zod `.describe()` help text, when set. */
  description?: string;
  /** True for a `field.translatable()` string leaf (drives slug auto-derivation). */
  translatable?: boolean;
  /** Enum options (kind === "enum"). */
  enumOptions?: string[];
  /** Relation target type id (kind === "relation"). */
  relationTarget?: string;
  relationMultiple?: boolean;
  /** Asset constraints (kind === "asset"). */
  asset?: AssetMeta;
}

function leafTypeName(schema: z.ZodTypeAny): string | undefined {
  return (schema as z.ZodTypeAny & { _def?: { type?: string } })._def?.type;
}

function isWrappedOptional(schema: z.ZodTypeAny): boolean {
  const type = leafTypeName(schema);
  return type === "optional" || type === "nullable" || type === "default";
}

function enumOptionsOf(leaf: z.ZodTypeAny): string[] | undefined {
  const withOptions = leaf as z.ZodTypeAny & { options?: unknown };
  const options = withOptions.options;
  if (Array.isArray(options) && options.every((o) => typeof o === "string")) {
    return options as string[];
  }
  return undefined;
}

/**
 * Classify every top-level field of a content schema into a form widget. Nested
 * objects, object-arrays, scalar arrays and anything that doesn't map onto a
 * scalar/enum/relation/asset widget fall through to the `"yaml"` escape hatch.
 * Order follows schema declaration order.
 */
export function formFieldsFor(schema: z.ZodTypeAny): FormField[] {
  const base = peelOptionalWrappers(schema);
  if (!(base instanceof Object && "shape" in base)) return [];
  const shape = (base as z.ZodObject<z.ZodRawShape>).shape;

  const out: FormField[] = [];
  for (const [key, child] of Object.entries(shape)) {
    const description = getFieldDescription(child as z.ZodTypeAny);

    const relation = getRelationTarget(child as z.ZodTypeAny);
    if (relation) {
      out.push({
        key,
        kind: "relation",
        optional: relation.optional,
        description,
        relationTarget: relation.typeId,
        relationMultiple: relation.multiple,
      });
      continue;
    }

    const asset = getAssetMeta(child as z.ZodTypeAny);
    if (asset) {
      out.push({
        key,
        kind: "asset",
        // A templated single field is loader-filled, so treat it as omittable.
        optional: asset.optional || Boolean(asset.template),
        description,
        asset,
      });
      continue;
    }

    const optional = isWrappedOptional(child as z.ZodTypeAny);
    const leaf = peelOptionalWrappers(child as z.ZodTypeAny);
    const type = leafTypeName(leaf);
    if (type === "string") {
      out.push({
        key,
        kind: "text",
        optional,
        description,
        translatable: getFieldKind(child as z.ZodTypeAny) === "translatable",
      });
    } else if (type === "number") {
      out.push({ key, kind: "number", optional, description });
    } else if (type === "boolean") {
      out.push({ key, kind: "boolean", optional, description });
    } else if (type === "enum") {
      out.push({ key, kind: "enum", optional, description, enumOptions: enumOptionsOf(leaf) });
    } else {
      // Objects, arrays of objects, scalar arrays, unions, records… → YAML.
      out.push({ key, kind: "yaml", optional, description });
    }
  }
  return out;
}

/** The field whose value seeds the slug (first translatable string, else first text). */
export function slugSourceField(fields: FormField[]): FormField | undefined {
  return fields.find((f) => f.kind === "text" && f.translatable) ?? fields.find((f) => f.kind === "text");
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export interface EntryFormContext {
  project: ScribeProject;
  config: ScribeConfig;
  type: ContentTypeRuntime;
  mode: "create" | "edit";
  /** Current slug: editable on create (may be ""), read-only on edit. */
  slug: string;
  /** Frontmatter values to prefill (raw source values, as read off disk). */
  values: Record<string, unknown>;
  /** MDX body to prefill. */
  body: string;
  /** Per-field error messages, keyed by field key (plus `slug`, `body`, `_form`). */
  errors?: Record<string, string>;
  /** POST target for the form. */
  postAction: string;
  /** Where Cancel links to. */
  cancelHref: string;
}

function helpLine(description?: string): string {
  return description ? `<div class="field-help">${escapeHtml(description)}</div>` : "";
}

function errorLine(errors: Record<string, string> | undefined, key: string): string {
  const msg = errors?.[key];
  return msg ? `<div class="field-error">${escapeHtml(msg)}</div>` : "";
}

function requiredMark(field: FormField): string {
  return field.optional ? "" : ` <span class="req" title="required">*</span>`;
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  return [];
}

function toYamlPreview(value: unknown): string {
  if (value === undefined || value === null) return "";
  try {
    return yaml.safeDump(value).replace(/\n$/, "");
  } catch {
    return "";
  }
}

/** Options for a relation picker: `{ slug, title }` (title falls back to the slug). */
function relationOptions(
  project: ScribeProject,
  target: string,
): Array<{ slug: string; title: string }> {
  try {
    const runtime = project.getType(target);
    return runtime.list().map((doc) => {
      const title = docTitleFromFrontmatter(doc.frontmatter as Record<string, unknown>, doc.enSlug);
      return { slug: doc.enSlug, title };
    });
  } catch {
    return [];
  }
}

/** Above this many options the relation picker renders a client-side filter input. */
const REL_FILTER_THRESHOLD = 8;

/**
 * Unified searchable relation picker. Radios for single relations, checkboxes
 * for multiple — the POST payload contract with `entry-write.ts` is unchanged
 * (same `f:{key}` names/values the old `<select>` / checkbox list produced).
 * The filter input has no `name`, so it is never submitted; filtered-out rows
 * are only visually hidden and keep their checked state.
 */
function renderRelationField(ctx: EntryFormContext, field: FormField, value: unknown): string {
  const options = relationOptions(ctx.project, field.relationTarget!);
  const multiple = field.relationMultiple === true;
  const name = fieldName(field.key);
  const inputType = multiple ? "checkbox" : "radio";

  const rows: string[] = [];
  if (!multiple && field.optional) {
    // Mirrors the old empty <option value="">: checked when there is no value.
    const noneChecked = typeof value === "string" ? value === "" : value == null;
    rows.push(
      `<label class="rel-option rel-none"><input type="radio" name="${name}" value=""${
        noneChecked ? " checked" : ""
      } /> <span class="dim">— none —</span></label>`,
    );
  }

  const currentMulti = new Set(asStringArray(value));
  const currentSingle = typeof value === "string" ? value : "";
  for (const o of options) {
    const checked = multiple ? currentMulti.has(o.slug) : currentSingle !== "" && o.slug === currentSingle;
    const slugSpan = o.title === o.slug ? "" : ` <span class="mono">${escapeHtml(o.slug)}</span>`;
    rows.push(
      `<label class="rel-option"><input type="${inputType}" name="${name}" value="${escapeHtml(o.slug)}"${
        checked ? " checked" : ""
      } /> <span>${escapeHtml(o.title)}</span>${slugSpan}</label>`,
    );
  }

  const list = rows.length
    ? rows.join("")
    : `<span class="dim">No ${escapeHtml(field.relationTarget!)} entries</span>`;
  const filter =
    options.length > REL_FILTER_THRESHOLD
      ? `<input type="search" class="rel-filter" placeholder="Filter…" autocomplete="off" />
      <div class="rel-count">${options.length} of ${options.length}</div>`
      : "";
  return `<div class="rel-picker">${filter}<div class="rel-options">${list}</div></div>`;
}

function renderField(ctx: EntryFormContext, field: FormField): string {
  const { values, errors } = ctx;
  const label = `<label for="${escapeHtml(field.key)}">${escapeHtml(field.key)}${requiredMark(field)}</label>`;
  const help = helpLine(field.description);
  const err = errorLine(errors, field.key);
  const value = values[field.key];

  let control = "";
  switch (field.kind) {
    case "text": {
      const v = typeof value === "string" ? value : "";
      control = `<input type="text" id="${escapeHtml(field.key)}" name="${fieldName(field.key)}" value="${escapeHtml(v)}"${
        field.translatable ? ' data-slug-source="1"' : ""
      } />`;
      break;
    }
    case "number": {
      const v =
        typeof value === "number" ? String(value) : typeof value === "string" ? value : "";
      control = `<input type="number" step="any" id="${escapeHtml(field.key)}" name="${fieldName(field.key)}" value="${escapeHtml(v)}" />`;
      break;
    }
    case "boolean": {
      const checked = value === true ? " checked" : "";
      control = `<label class="checkbox"><input type="checkbox" id="${escapeHtml(field.key)}" name="${fieldName(field.key)}"${checked} /> <span class="dim">${escapeHtml(field.key)}</span></label>`;
      break;
    }
    case "enum": {
      const options = field.enumOptions ?? [];
      const selected = typeof value === "string" ? value : "";
      const empty = field.optional ? `<option value=""${selected === "" ? " selected" : ""}>—</option>` : "";
      const opts = options
        .map(
          (o) => `<option value="${escapeHtml(o)}"${o === selected ? " selected" : ""}>${escapeHtml(o)}</option>`,
        )
        .join("");
      control = `<select id="${escapeHtml(field.key)}" name="${fieldName(field.key)}">${empty}${opts}</select>`;
      break;
    }
    case "relation": {
      control = renderRelationField(ctx, field, value);
      break;
    }
    case "asset": {
      control = renderAssetField(ctx, field, value);
      break;
    }
    case "yaml": {
      // On a validation re-render `value` is the raw string the user typed;
      // when prefilling from disk it is a parsed structure to dump.
      const v = typeof value === "string" ? value : toYamlPreview(value);
      control = `<textarea class="yaml" id="${escapeHtml(field.key)}" name="${yamlName(field.key)}" rows="6" spellcheck="false">${escapeHtml(v)}</textarea>
        <div class="field-help">Structural field — edit as YAML.</div>`;
      break;
    }
  }

  return `<div class="form-field">${label}${help}${control}${err}</div>`;
}

function renderAssetField(ctx: EntryFormContext, field: FormField, value: unknown): string {
  const asset = field.asset!;
  const constraints: string[] = [];
  if (asset.formats && asset.formats.length > 0) constraints.push(asset.formats.map((f) => `.${f}`).join(", "));
  if (asset.maxKB !== undefined) constraints.push(`≤ ${asset.maxKB}KB`);
  const constraintLine = constraints.length ? `<div class="field-help">${escapeHtml(constraints.join(" · "))}</div>` : "";
  const accept = asset.formats && asset.formats.length > 0 ? ` accept="${asset.formats.map((f) => `.${f}`).join(",")}"` : "";

  if (asset.multiple) {
    const existing = asStringArray(value);
    const existingItems = existing
      .map((webPath, i) => {
        return `<div class="asset-item">
          <div class="frame"><img loading="lazy" src="${assetPreviewUrl(webPath)}" alt="" /></div>
          <label class="checkbox"><input type="checkbox" name="${removeName(field.key, i)}" /> <span class="dim">remove</span></label>
          <div class="apath mono">${escapeHtml(webPath)}</div>
        </div>`;
      })
      .join("");
    const existingBlock = existing.length
      ? `<div class="asset-item-list">${existingItems}</div>`
      : "";
    return `${existingBlock}
      <input type="file" multiple name="${fileName(field.key)}"${accept} class="js-file-multi" data-preview="preview-${escapeHtml(field.key)}" />
      <div class="asset-item-list js-preview" id="preview-${escapeHtml(field.key)}"></div>
      ${constraintLine}`;
  }

  // Single asset.
  let destHint = "";
  if (asset.template) {
    const dest = asset.template.split("{slug}").join(ctx.slug || "{slug}");
    destHint = `<div class="field-help">Destination <span class="mono dest" data-template="${escapeHtml(asset.template)}">${escapeHtml(dest)}</span> (frontmatter key omitted — loader fills it)</div>`;
  } else if (asset.dir) {
    const dir = `/${asset.dir.replace(/^\/+|\/+$/g, "")}`;
    const dest = `${dir}/${ctx.slug || "{slug}"}.<ext>`;
    destHint = `<div class="field-help">Destination <span class="mono dest" data-dir="${escapeHtml(dir)}">${escapeHtml(dest)}</span></div>`;
  }

  const currentPath = typeof value === "string" ? value : "";
  const currentThumb =
    ctx.mode === "edit" && currentPath
      ? `<div class="asset-current"><div class="frame"><img loading="lazy" src="${assetPreviewUrl(currentPath)}" alt="" /></div><div class="apath mono">${escapeHtml(currentPath)}</div></div>`
      : "";

  return `${currentThumb}
    <input type="file" name="${fileName(field.key)}"${accept} class="js-file-single" data-preview="preview-${escapeHtml(field.key)}" />
    <div class="asset-current js-preview" id="preview-${escapeHtml(field.key)}"></div>
    ${destHint}${constraintLine}`;
}

/** The small inline client script: slugify + templated-destination live updates + file previews. */
function formScript(fields: FormField[], mode: "create" | "edit"): string {
  const source = slugSourceField(fields);
  const sourceKey = source ? source.key : null;
  return `<script>(function(){
    var slug=document.getElementById(${JSON.stringify(SLUG_FIELD)});
    var manual=${mode === "edit" ? "true" : "false"};
    function slugify(s){return s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"");}
    function updateDests(){
      var v=slug?slug.value:"";
      document.querySelectorAll("[data-template]").forEach(function(el){el.textContent=el.getAttribute("data-template").split("{slug}").join(v||"{slug}");});
      document.querySelectorAll("[data-dir]").forEach(function(el){el.textContent=el.getAttribute("data-dir")+"/"+(v||"{slug}")+".<ext>";});
    }
    if(slug){slug.addEventListener("input",function(){manual=true;updateDests();});}
    ${
      sourceKey
        ? `var src=document.querySelector('[data-slug-source="1"]');
    if(src&&slug){src.addEventListener("input",function(){if(!manual){slug.value=slugify(src.value);updateDests();}});}`
        : ""
    }
    document.querySelectorAll(".js-file-single").forEach(function(inp){
      inp.addEventListener("change",function(){
        var box=document.getElementById(inp.getAttribute("data-preview"));if(!box)return;box.innerHTML="";
        var f=inp.files&&inp.files[0];if(!f)return;
        var url=URL.createObjectURL(f);
        box.innerHTML='<div class="frame"><img src="'+url+'" alt=""></div><div class="apath mono">'+f.name+'</div>';
      });
    });
    document.querySelectorAll(".rel-picker .rel-filter").forEach(function(inp){
      inp.addEventListener("input",function(){
        var picker=inp.closest(".rel-picker");if(!picker)return;
        var q=inp.value.toLowerCase();var shown=0;
        var rows=picker.querySelectorAll(".rel-option:not(.rel-none)");
        rows.forEach(function(row){
          var hit=row.textContent.toLowerCase().indexOf(q)!==-1;
          row.classList.toggle("rel-hidden",!hit);
          if(hit)shown++;
        });
        var count=picker.querySelector(".rel-count");
        if(count)count.textContent=shown+" of "+rows.length;
      });
    });
    document.querySelectorAll(".js-file-multi").forEach(function(inp){
      inp.addEventListener("change",function(){
        var box=document.getElementById(inp.getAttribute("data-preview"));if(!box)return;box.innerHTML="";
        for(var i=0;i<inp.files.length;i++){var f=inp.files[i];var url=URL.createObjectURL(f);
          var d=document.createElement("div");d.className="asset-item";
          d.innerHTML='<div class="frame"><img src="'+url+'" alt=""></div><div class="apath mono">'+f.name+'</div>';
          box.appendChild(d);}
      });
    });
    updateDests();
  })();</script>`;
}

/** Render the full create/edit form page body (toolbar is added by the caller). */
export function renderEntryForm(ctx: EntryFormContext): string {
  const { type, mode, errors } = ctx;
  const schema = type.config.schema as z.ZodTypeAny;
  const fields = formFieldsFor(schema);

  const formError = errors?._form
    ? `<div class="form-banner form-banner-err">${escapeHtml(errors._form)}</div>`
    : "";

  // Slug: editable + auto-derived on create; read-only on edit.
  const slugControl =
    mode === "edit"
      ? `<input type="text" id="${SLUG_FIELD}" name="${SLUG_FIELD}" value="${escapeHtml(ctx.slug)}" readonly />
         <div class="field-help">Slug is fixed. Renaming is not supported in the studio.</div>`
      : `<input type="text" id="${SLUG_FIELD}" name="${SLUG_FIELD}" value="${escapeHtml(ctx.slug)}" placeholder="my-entry-slug" />
         <div class="field-help">EN slug (lowercase kebab-case). Auto-filled from the first text field until you edit it.</div>`;
  const slugField = `<div class="form-field"><label for="${SLUG_FIELD}">slug <span class="req" title="required">*</span></label>${slugControl}${errorLine(errors, SLUG_FIELD)}</div>`;

  const fieldBlocks = fields.map((f) => renderField(ctx, f)).join("");

  const bodyBlock =
    type.config.body === false
      ? ""
      : `<div class="form-field"><label for="${BODY_FIELD}">body</label>
         <div class="field-help">MDX body.</div>
         <textarea class="body-editor" id="${BODY_FIELD}" name="${BODY_FIELD}" spellcheck="false">${escapeHtml(ctx.body)}</textarea>
         ${errorLine(errors, BODY_FIELD)}</div>`;

  const saveLabel = mode === "create" ? "Create entry" : "Save changes";

  return `<form class="entry-form" method="post" action="${ctx.postAction}" enctype="multipart/form-data">
      ${formError}
      ${slugField}
      ${fieldBlocks}
      ${bodyBlock}
      <div class="form-actions">
        <button type="submit" class="btn-primary btn-lg">${escapeHtml(saveLabel)}</button>
        <a class="btn" href="${ctx.cancelHref}">Cancel</a>
      </div>
    </form>
    ${formScript(fields, mode)}`;
}

/** Toolbar breadcrumb for the create/edit pages. */
export function entryFormToolbar(
  type: ContentTypeRuntime,
  crumbLabel: string,
  entryHref?: string,
): string {
  const typeLink = `<a href="/types/${encodePathSegment(type.id)}">${escapeHtml(type.config.label)}</a>`;
  const tail = entryHref
    ? `<a href="${entryHref}">${escapeHtml(crumbLabel)}</a>`
    : `<span>${escapeHtml(crumbLabel)}</span>`;
  return `<div class="toolbar">
      <a href="/">Overview</a><span class="sep">›</span>
      ${typeLink}<span class="sep">›</span>
      ${tail}
    </div>`;
}
