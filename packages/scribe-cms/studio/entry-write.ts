import fs from "node:fs";
import path from "node:path";
import type { Context } from "hono";
import matter from "gray-matter";
import yaml from "js-yaml";
import type { z } from "zod";
import { SLUG_PATTERN } from "../src/core/builtin-fields.js";
import { listEnSlugs } from "../src/core/alias-helpers.js";
import { bumpContentVersion } from "../src/loader/create-loader.js";
import { loadTypeRedirectsFile } from "../src/redirects/load-type-redirects.js";
import type { ContentTypeRuntime, ScribeProject } from "../src/core/types.js";
import {
  BODY_FIELD,
  FIELD_PREFIX,
  FILE_PREFIX,
  REMOVE_PREFIX,
  SLUG_FIELD,
  YAML_PREFIX,
  formFieldsFor,
  type FormField,
} from "./entry-forms.js";

/**
 * Studio entry writer. Parses a create/edit form submission, validates it
 * (Zod schema, relation targets, upload constraints) and — only when fully
 * valid — writes plain files: one `.md`/`.mdx` frontmatter file per entry plus
 * any uploaded image files under the assets dir. No DB writes, no hidden state:
 * a studio session's git diff looks like a human edited files.
 */

// ---------------------------------------------------------------------------
// Normalized form input (decoupled from Hono for unit testing)
// ---------------------------------------------------------------------------

export interface UploadedFile {
  /** Original client filename (used only for its extension). */
  filename: string;
  /** Lowercased extension without the dot (e.g. `"webp"`). */
  ext: string;
  /** Byte length. */
  size: number;
  bytes: Buffer;
}

export interface EntryFormInput {
  slug: string;
  body: string;
  /** Scalar / enum / relation values, keyed by field key (string or string[]). */
  fields: Record<string, string | string[]>;
  /** Raw YAML textarea contents, keyed by field key. */
  yaml: Record<string, string>;
  /** Uploaded files by field key (single field → one element; multiple → many). */
  files: Record<string, UploadedFile[]>;
  /** Edit only: existing-item indices marked for removal, per multiple asset field. */
  removedAssets?: Record<string, Set<number>>;
}

export interface WriteEntryResult {
  ok: boolean;
  /** Per-field error messages (keys: field keys, `slug`, `body`, `_form`). */
  errors?: Record<string, string>;
  /** Absolute path of the written entry file (success only). */
  filePath?: string;
  /** Absolute paths of image files written (success only). */
  writtenAssets?: string[];
}

/** Sentinel: this field is intentionally absent from frontmatter. */
const OMIT = Symbol("omit");

// ---------------------------------------------------------------------------
// Small filesystem / path helpers (kept local to avoid re-exporting internals)
// ---------------------------------------------------------------------------

function enFilePath(rootDir: string, contentDir: string, enSlug: string): string | null {
  for (const ext of [".mdx", ".md"]) {
    const candidate = path.join(rootDir, contentDir, `${enSlug}${ext}`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function normalizeDir(dir: string): string {
  return `/${dir.replace(/^\/+|\/+$/g, "")}`;
}

function assetAbsPath(assetsPath: string, webPath: string): string {
  return path.join(assetsPath, webPath.replace(/^\/+/, ""));
}

function materialize(template: string, slug: string): string {
  return template.split("{slug}").join(slug);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Rewrite only the frontmatter block of a raw MDX string, preserving the body
 * bytes verbatim. Mirrors the deletion executor's helper.
 */
function rewriteFrontmatter(raw: string, data: Record<string, unknown>): string {
  const match = raw.match(/^(﻿)?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/);
  const bom = match?.[1] ?? "";
  const body = match ? raw.slice(match[0].length) : raw;
  const serialized = matter.stringify("", data);
  const blockMatch = serialized.match(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n/);
  const block = blockMatch ? blockMatch[0] : serialized;
  return `${bom}${block}${body}`;
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  return [];
}

// ---------------------------------------------------------------------------
// Core writer
// ---------------------------------------------------------------------------

/** Slugs already taken by an entry or a `_redirects.json` alias in this type. */
function takenSlugs(project: ScribeProject, type: ContentTypeRuntime): Set<string> {
  const config = project.config;
  const slugs = new Set(listEnSlugs(config.rootDir, type.config.contentDir));
  try {
    const redirects = loadTypeRedirectsFile(config, type.config);
    if (redirects) {
      for (const entry of redirects.entries) {
        for (const from of entry.fromSlugs) slugs.add(from);
      }
    }
  } catch {
    // A malformed _redirects.json shouldn't block entry creation; skip aliases.
  }
  return slugs;
}

/** Existing EN slugs of a relation target type (for existence validation). */
function targetSlugSet(project: ScribeProject, targetId: string): Set<string> {
  try {
    const target = project.getType(targetId);
    return new Set(listEnSlugs(project.config.rootDir, target.config.contentDir));
  } catch {
    return new Set();
  }
}

interface AssetPlanItem {
  absPath: string;
  bytes: Buffer;
}

/**
 * Validate a form submission and write it to disk. Returns `{ ok: false, errors }`
 * with all values preserved by the caller when anything fails; nothing is written
 * until every check passes.
 */
export function writeEntry(
  project: ScribeProject,
  type: ContentTypeRuntime,
  mode: "create" | "edit",
  input: EntryFormInput,
): WriteEntryResult {
  const config = project.config;
  const schema = type.config.schema as z.ZodTypeAny;
  const fields = formFieldsFor(schema);
  const errors: Record<string, string> = {};
  const setError = (key: string, message: string): void => {
    if (!errors[key]) errors[key] = message;
  };

  const slug = (input.slug || "").trim();

  // --- Slug validity + (create) collision ---
  if (!SLUG_PATTERN.test(slug)) {
    setError(SLUG_FIELD, "Slug must be lowercase kebab-case (letters, digits, hyphens).");
  } else if (mode === "create") {
    if (takenSlugs(project, type).has(slug)) {
      setError(SLUG_FIELD, `An entry or redirect alias with slug "${slug}" already exists.`);
    }
  }

  // --- Read the existing file (edit) to preserve unmanaged keys + body ---
  let existingRaw: string | null = null;
  let existingData: Record<string, unknown> = {};
  let existingBody = "";
  let editFilePath: string | null = null;
  if (mode === "edit") {
    editFilePath = enFilePath(config.rootDir, type.config.contentDir, slug);
    if (!editFilePath) {
      return { ok: false, errors: { _form: `Entry "${slug}" not found.` } };
    }
    existingRaw = fs.readFileSync(editFilePath, "utf8");
    const parsed = matter(existingRaw);
    existingData = structuredClone(parsed.data) as Record<string, unknown>;
    existingBody = parsed.content;
  }

  const assetsPath = config.assets?.assetsPath ?? config.assetsPath;

  // --- Compute asset destinations + validate uploads (no writes yet) ---
  const assetPlan: AssetPlanItem[] = [];
  const assetValues = new Map<string, unknown | typeof OMIT>();

  for (const field of fields) {
    if (field.kind !== "asset" || !field.asset) continue;
    const meta = field.asset;
    const uploads = input.files[field.key] ?? [];

    const validateUpload = (file: UploadedFile): boolean => {
      if (meta.formats && meta.formats.length > 0 && !meta.formats.includes(file.ext)) {
        setError(field.key, `File .${file.ext} is not an allowed format (${meta.formats.join(", ")}).`);
        return false;
      }
      if (meta.maxKB !== undefined && file.size > meta.maxKB * 1024) {
        setError(
          field.key,
          `File is ${Math.round(file.size / 1024)}KB, over the ${meta.maxKB}KB budget.`,
        );
        return false;
      }
      return true;
    };

    if (meta.multiple) {
      const existingArr = mode === "edit" ? asStringArray(existingData[field.key]) : [];
      const removed = input.removedAssets?.[field.key] ?? new Set<number>();
      const kept = existingArr.filter((_, i) => !removed.has(i));

      // Continue numbering after the highest existing `{slug}-{n}` index we keep.
      let highest = -1;
      const re = new RegExp(`^${escapeRegExp(slug)}-(\\d+)\\.`);
      for (const p of kept) {
        const m = path.basename(p).match(re);
        if (m) highest = Math.max(highest, Number(m[1]));
      }
      const prefix = meta.dir ? normalizeDir(meta.dir) : "";
      const newPaths: string[] = [];
      let n = highest + 1;
      for (const file of uploads) {
        if (!validateUpload(file)) continue;
        const webPath = `${prefix}/${slug}-${n}.${file.ext}`;
        newPaths.push(webPath);
        if (assetsPath) assetPlan.push({ absPath: assetAbsPath(assetsPath, webPath), bytes: file.bytes });
        n++;
      }
      const finalArr = [...kept, ...newPaths];
      assetValues.set(field.key, finalArr.length > 0 ? finalArr : field.optional ? OMIT : finalArr);
      continue;
    }

    // Single asset field.
    const file = uploads[0];
    if (file) {
      if (validateUpload(file)) {
        let webPath: string;
        if (meta.template) {
          webPath = materialize(meta.template, slug);
          assetValues.set(field.key, OMIT); // loader materializes templated paths
        } else {
          const prefix = meta.dir ? normalizeDir(meta.dir) : "";
          webPath = `${prefix}/${slug}.${file.ext}`;
          assetValues.set(field.key, webPath);
        }
        if (assetsPath) assetPlan.push({ absPath: assetAbsPath(assetsPath, webPath), bytes: file.bytes });
      }
    } else if (mode === "edit") {
      // No new upload → keep the existing value (templated keys stay omitted).
      assetValues.set(field.key, meta.template ? OMIT : (existingData[field.key] ?? OMIT));
    } else {
      // Create with no file.
      if (meta.template || meta.optional) {
        assetValues.set(field.key, OMIT);
      } else {
        setError(field.key, "An image file is required.");
      }
    }
  }

  if (assetPlan.length > 0 && !assetsPath) {
    setError("_form", "This project has no assets dir configured, so files cannot be uploaded.");
  }

  // --- Build the frontmatter object from non-asset fields (coerced) ---
  const data: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.kind === "asset") {
      const value = assetValues.get(field.key);
      if (value !== undefined && value !== OMIT) data[field.key] = value;
      continue;
    }
    if (field.kind === "yaml") {
      const raw = input.yaml[field.key];
      if (raw === undefined || raw.trim() === "") continue; // omit; Zod flags if required
      try {
        // safeLoad: js-yaml v3's load() uses the full schema, where !!js/function
        // compiles code at parse time — never acceptable, even on localhost.
        const parsed = yaml.safeLoad(raw);
        if (parsed !== undefined && parsed !== null) data[field.key] = parsed;
      } catch (err) {
        setError(field.key, `Invalid YAML: ${err instanceof Error ? err.message : String(err)}`);
      }
      continue;
    }
    coerceScalar(field, input, data, setError);
  }

  // --- Validation (1): Zod schema ---
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const topKey = typeof issue.path[0] === "string" ? issue.path[0] : "_form";
      setError(topKey, issue.message);
    }
  }

  // --- Validation (2): relation targets exist ---
  for (const field of fields) {
    if (field.kind !== "relation" || !field.relationTarget) continue;
    const value = data[field.key];
    const slugs = field.relationMultiple ? asStringArray(value) : typeof value === "string" ? [value] : [];
    if (slugs.length === 0) continue;
    const known = targetSlugSet(project, field.relationTarget);
    for (const s of slugs) {
      if (!known.has(s)) {
        setError(field.key, `Related ${field.relationTarget} "${s}" does not exist.`);
        break;
      }
    }
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  // --- Everything is valid: write image files, then the entry file ---
  const writtenAssets: string[] = [];
  for (const item of assetPlan) {
    fs.mkdirSync(path.dirname(item.absPath), { recursive: true });
    fs.writeFileSync(item.absPath, item.bytes);
    writtenAssets.push(item.absPath);
  }

  const bodyEnabled = type.config.body !== false;
  const newBody = bodyEnabled ? input.body ?? "" : "";

  let filePath: string;
  if (mode === "edit" && editFilePath) {
    // Preserve keys not managed by the schema (publishedAt, updatedAt, vars…).
    const managed = new Set(fields.map((f) => f.key));
    const newData: Record<string, unknown> = { ...existingData };
    for (const key of managed) {
      if (key in data) newData[key] = data[key];
      else delete newData[key];
    }
    const bodyChanged = bodyEnabled && newBody !== existingBody;
    if (bodyChanged) {
      fs.writeFileSync(editFilePath, matter.stringify(newBody, newData), "utf8");
    } else {
      // Keep body bytes exactly; only the frontmatter block is re-serialized.
      fs.writeFileSync(editFilePath, rewriteFrontmatter(existingRaw!, newData), "utf8");
    }
    filePath = editFilePath;
  } else {
    // Scribe creates .mdx only; existing .md files stay readable and editable.
    filePath = path.join(config.rootDir, type.config.contentDir, `${slug}.mdx`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, matter.stringify(newBody, data), "utf8");
  }

  // Force in-process loaders to rebuild so the new/edited entry shows at once.
  bumpContentVersion();

  return { ok: true, filePath, writtenAssets };
}

/** Coerce a scalar/enum/boolean/relation form value into `data`, recording errors. */
function coerceScalar(
  field: FormField,
  input: EntryFormInput,
  data: Record<string, unknown>,
  setError: (key: string, message: string) => void,
): void {
  const raw = input.fields[field.key];
  switch (field.kind) {
    case "text": {
      const s = typeof raw === "string" ? raw : "";
      if (s.trim() !== "") data[field.key] = s;
      break;
    }
    case "number": {
      const s = (typeof raw === "string" ? raw : "").trim();
      if (s === "") break;
      const n = Number(s);
      if (Number.isNaN(n)) setError(field.key, "Must be a number.");
      else data[field.key] = n;
      break;
    }
    case "boolean": {
      const checked = raw !== undefined && raw !== "";
      if (checked) data[field.key] = true;
      else if (!field.optional) data[field.key] = false;
      break;
    }
    case "enum": {
      const s = typeof raw === "string" ? raw : "";
      if (s !== "") data[field.key] = s;
      break;
    }
    case "relation": {
      if (field.relationMultiple) {
        const arr = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter((v) => v);
        if (arr.length > 0) data[field.key] = arr;
        else if (!field.optional) data[field.key] = [];
      } else {
        const s = (typeof raw === "string" ? raw : "").trim();
        if (s !== "") data[field.key] = s;
      }
      break;
    }
    default:
      break;
  }
}

/**
 * Reconstruct a form-prefill `values` map (non-asset fields) from a submitted
 * input, so a validation-failed render preserves exactly what the user entered.
 * Asset fields are intentionally skipped — the caller overlays these onto the
 * on-disk document values (file inputs can't be re-populated by the browser).
 */
export function formValuesFromInput(
  fields: FormField[],
  input: EntryFormInput,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.kind === "asset") continue;
    if (field.kind === "yaml") {
      out[field.key] = input.yaml[field.key] ?? "";
      continue;
    }
    const raw = input.fields[field.key];
    if (field.kind === "boolean") {
      out[field.key] = raw !== undefined && raw !== "";
    } else if (field.kind === "relation" && field.relationMultiple) {
      out[field.key] = Array.isArray(raw) ? raw : raw ? [raw] : [];
    } else {
      out[field.key] = typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] ?? "" : "";
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Hono multipart adapter
// ---------------------------------------------------------------------------

function extOf(filename: string): string {
  const ext = path.extname(filename).slice(1).toLowerCase();
  return ext;
}

async function toUploadedFile(value: File): Promise<UploadedFile | null> {
  if (!value.name || value.size === 0) return null; // empty file input
  const bytes = Buffer.from(await value.arrayBuffer());
  return { filename: value.name, ext: extOf(value.name), size: bytes.length, bytes };
}

/**
 * Read a Hono request's multipart body into a normalized `EntryFormInput`.
 * Multi-valued fields (relation checkboxes, multiple uploads) are collected via
 * `parseBody({ all: true })`.
 */
export async function readEntryForm(c: Context, fields: FormField[]): Promise<EntryFormInput> {
  const body = await c.req.parseBody({ all: true });
  const multipleFieldKeys = new Set(
    fields.filter((f) => f.kind === "relation" && f.relationMultiple).map((f) => f.key),
  );

  const out: EntryFormInput = {
    slug: "",
    body: "",
    fields: {},
    yaml: {},
    files: {},
    removedAssets: {},
  };

  const asArray = <T>(v: T | T[] | undefined): T[] =>
    v === undefined ? [] : Array.isArray(v) ? v : [v];

  for (const [name, value] of Object.entries(body)) {
    if (name === SLUG_FIELD) {
      out.slug = typeof value === "string" ? value : "";
      continue;
    }
    if (name === BODY_FIELD) {
      out.body = typeof value === "string" ? value : "";
      continue;
    }
    if (name.startsWith(FIELD_PREFIX)) {
      const key = name.slice(FIELD_PREFIX.length);
      const strings = asArray(value).filter((v): v is string => typeof v === "string");
      out.fields[key] = multipleFieldKeys.has(key) ? strings : strings[0] ?? "";
      continue;
    }
    if (name.startsWith(YAML_PREFIX)) {
      const key = name.slice(YAML_PREFIX.length);
      out.yaml[key] = typeof value === "string" ? value : "";
      continue;
    }
    if (name.startsWith(REMOVE_PREFIX)) {
      // remove:{key}:{index}
      const rest = name.slice(REMOVE_PREFIX.length);
      const idx = rest.lastIndexOf(":");
      if (idx > 0) {
        const key = rest.slice(0, idx);
        const index = Number(rest.slice(idx + 1));
        if (!Number.isNaN(index)) {
          (out.removedAssets![key] ??= new Set()).add(index);
        }
      }
      continue;
    }
    if (name.startsWith(FILE_PREFIX)) {
      const key = name.slice(FILE_PREFIX.length);
      const uploaded: UploadedFile[] = [];
      for (const v of asArray(value)) {
        if (v instanceof File) {
          const file = await toUploadedFile(v);
          if (file) uploaded.push(file);
        }
      }
      out.files[key] = uploaded;
      continue;
    }
  }

  return out;
}
