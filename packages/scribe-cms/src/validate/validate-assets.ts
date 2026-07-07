import fs from "node:fs";
import path from "node:path";
import type { z } from "zod";
import { listAssetFields, type SchemaFieldMeta } from "../core/introspect-schema.js";
import type { ScribeConfig } from "../core/types.js";

const IMAGE_EXT = String.raw`(?:png|jpe?g|webp|gif|svg)`;
const IMAGE_WEB_PATH = String.raw`\/[\w\-./]+\.${IMAGE_EXT}`;
const MARKDOWN_IMAGE_RE = new RegExp(
  String.raw`!\[[^\]]*\]\((${IMAGE_WEB_PATH})\)`,
  "gi",
);
const HTML_SRC_RE = new RegExp(String.raw`src=["'](${IMAGE_WEB_PATH})["']`, "gi");

function isImageWebPath(value: string): boolean {
  return new RegExp(String.raw`^${IMAGE_WEB_PATH}$`, "i").test(value);
}

function isSiteAssetPath(webPath: string): boolean {
  const segment = webPath.split("/")[1];
  return Boolean(segment && !segment.includes("."));
}

function addImagePath(webPath: string, out: Set<string>): void {
  if (isSiteAssetPath(webPath)) out.add(webPath);
}

function collectBodyImagePaths(body: string, out: Set<string>): void {
  for (const re of [MARKDOWN_IMAGE_RE, HTML_SRC_RE]) {
    for (const match of body.matchAll(re)) {
      addImagePath(match[1]!, out);
    }
  }
}

function collectFrontmatterImagePaths(value: unknown, out: Set<string>): void {
  if (typeof value === "string") {
    if (isImageWebPath(value)) addImagePath(value, out);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectFrontmatterImagePaths(item, out);
    return;
  }
  if (value && typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      collectFrontmatterImagePaths(nested, out);
    }
  }
}

/** Collect absolute web paths to image assets from frontmatter values and MDX body. */
export function collectImagePaths(frontmatter: unknown, body: string): string[] {
  const paths = new Set<string>();
  collectFrontmatterImagePaths(frontmatter, paths);
  collectBodyImagePaths(body, paths);
  return [...paths].sort();
}

function assetFilePath(assetsPath: string, webPath: string): string {
  return path.join(assetsPath, webPath.replace(/^\//, ""));
}

export interface AssetValidateIssue {
  level: "error" | "warning";
  contentType?: string;
  enSlug?: string;
  locale?: string;
  field?: string;
  message: string;
}

/**
 * Warn when referenced image paths are missing from the configured assets
 * folder. Heuristic pass over frontmatter strings and MDX body images.
 *
 * @param skipPaths web paths already covered by declared-asset validation
 *   (`validateDeclaredAssetFields`), skipped here to avoid duplicate reporting.
 */
export function validateDocumentAssets(
  config: ScribeConfig,
  input: {
    contentType: string;
    enSlug: string;
    locale?: string;
    frontmatter: unknown;
    body: string;
  },
  skipPaths?: Set<string>,
): AssetValidateIssue[] {
  const assetsPath = config.assetsPath;
  if (!assetsPath) return [];

  const issues: AssetValidateIssue[] = [];
  for (const webPath of collectImagePaths(input.frontmatter, input.body)) {
    if (skipPaths?.has(webPath)) continue;
    const filePath = assetFilePath(assetsPath, webPath);
    if (fs.existsSync(filePath)) continue;
    issues.push({
      level: "warning",
      contentType: input.contentType,
      enSlug: input.enSlug,
      locale: input.locale,
      field: "asset",
      message: `Missing image asset ${webPath} (expected ${filePath})`,
    });
  }
  return issues;
}

/** Collect each concrete asset-field location value from frontmatter (arrays at `*`). */
function collectAssetValues(
  container: unknown,
  path: string[],
  out: Array<{ fieldPath: string; value: string | undefined }>,
  fieldPathSoFar: string[] = [],
): void {
  const [head, ...rest] = path;
  if (head === undefined) return;
  if (typeof container !== "object" || container === null || Array.isArray(container)) return;
  const record = container as Record<string, unknown>;

  if (rest.length === 0) {
    const value = record[head];
    out.push({
      fieldPath: [...fieldPathSoFar, head].join("."),
      value: typeof value === "string" ? value : undefined,
    });
    return;
  }

  if (rest[0] === "*") {
    const arr = record[head];
    if (!Array.isArray(arr)) {
      // No array present: report a single absent location for attribution.
      out.push({ fieldPath: [...fieldPathSoFar, head, "*", ...rest.slice(1)].join("."), value: undefined });
      return;
    }
    arr.forEach((item) => {
      collectAssetValues(item, rest.slice(1), out, [...fieldPathSoFar, head, "*"]);
    });
    return;
  }

  collectAssetValues(record[head], rest, out, [...fieldPathSoFar, head]);
}

function normalizeDir(dir: string): string {
  return `/${dir.replace(/^\/+|\/+$/g, "")}`;
}

/**
 * Validate declared `field.asset()` fields against the assets folder: required
 * fields present, files exist, values inside `dir`, extensions in `formats`,
 * sizes within `maxKB`, and templated paths materialized. Missing required or
 * present-but-absent files are errors; format/size violations are warnings.
 * Source frontmatter (unresolved) is expected. EN-sourced (structural) only.
 */
export function validateDeclaredAssetFields(
  config: ScribeConfig,
  input: {
    contentType: string;
    enSlug: string;
    locale?: string;
    frontmatter: Record<string, unknown>;
    schema: z.ZodTypeAny;
  },
): AssetValidateIssue[] {
  const assetsPath = config.assetsPath;
  if (!assetsPath) return [];

  const issues: AssetValidateIssue[] = [];
  const attrib = (fieldPath: string, level: "error" | "warning", message: string) =>
    issues.push({
      level,
      contentType: input.contentType,
      enSlug: input.enSlug,
      locale: input.locale,
      field: fieldPath,
      message,
    });

  for (const f of listAssetFields(input.schema)) {
    const locations: Array<{ fieldPath: string; value: string | undefined }> = [];
    collectAssetValues(input.frontmatter, f.path, locations);

    for (const { fieldPath, value } of locations) {
      let effective = value;
      // Templated field with no explicit value: materialize the derived path.
      if (effective === undefined && f.assetTemplate) {
        effective = f.assetTemplate.split("{slug}").join(input.enSlug);
      }

      if (effective === undefined) {
        if (!f.assetOptional) {
          attrib(fieldPath, "error", `${input.contentType}/${input.enSlug}: ${fieldPath} is required but missing`);
        }
        continue;
      }

      if (f.assetDir) {
        const dir = normalizeDir(f.assetDir);
        if (!(effective === dir || effective.startsWith(`${dir}/`))) {
          attrib(
            fieldPath,
            "error",
            `${input.contentType}/${input.enSlug}: ${fieldPath} value ${effective} is outside declared dir ${dir}`,
          );
        }
      }

      const filePath = assetFilePath(assetsPath, effective);
      if (!fs.existsSync(filePath)) {
        attrib(fieldPath, "error", `${input.contentType}/${input.enSlug}: ${fieldPath} → ${effective} not found`);
        continue;
      }

      if (f.assetFormats && f.assetFormats.length > 0) {
        const ext = path.extname(effective).slice(1).toLowerCase();
        if (!f.assetFormats.includes(ext)) {
          attrib(
            fieldPath,
            "warning",
            `${input.contentType}/${input.enSlug}: ${fieldPath} → ${effective} extension .${ext} not in formats [${f.assetFormats.join(", ")}]`,
          );
        }
      }

      if (f.assetMaxKB !== undefined) {
        try {
          const sizeKB = fs.statSync(filePath).size / 1024;
          if (sizeKB > f.assetMaxKB) {
            attrib(
              fieldPath,
              "warning",
              `${input.contentType}/${input.enSlug}: ${fieldPath} → ${effective} is ${Math.round(sizeKB)}KB, over the ${f.assetMaxKB}KB budget`,
            );
          }
        } catch {
          /* stat failure already implies a missing file, handled above */
        }
      }
    }
  }

  return issues;
}

/** Source (unresolved) web paths of every declared asset field, for heuristic skip. */
export function collectDeclaredAssetPaths(
  frontmatter: Record<string, unknown>,
  enSlug: string,
  schema: z.ZodTypeAny,
  fields?: SchemaFieldMeta[],
): Set<string> {
  const out = new Set<string>();
  for (const f of fields ?? listAssetFields(schema)) {
    const locations: Array<{ fieldPath: string; value: string | undefined }> = [];
    collectAssetValues(frontmatter, f.path, locations);
    for (const { value } of locations) {
      if (value !== undefined) out.add(value);
      else if (f.assetTemplate) out.add(f.assetTemplate.split("{slug}").join(enSlug));
    }
  }
  return out;
}
