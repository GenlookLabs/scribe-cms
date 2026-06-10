import type { z } from "zod";
import { getFieldKind, getRelationTarget, unwrapSchema } from "./field.js";

export interface SchemaFieldMeta {
  path: string[];
  kind: "translatable" | "structural" | "relation";
  relationTarget?: string;
  relationMultiple?: boolean;
  relationOptional?: boolean;
}

/** List schema fields with translatable/structural/relation metadata. */
export function introspectSchema(schema: z.ZodTypeAny, prefix: string[] = []): SchemaFieldMeta[] {
  const relation = getRelationTarget(schema);
  if (relation && prefix.length > 0) {
    return [
      {
        path: prefix,
        kind: "relation",
        relationTarget: relation.typeId,
        relationMultiple: relation.multiple,
        relationOptional: relation.optional,
      },
    ];
  }

  const base = unwrapSchema(schema);
  if (base instanceof Object && "shape" in base) {
    const shape = (base as z.ZodObject<z.ZodRawShape>).shape;
    const fields: SchemaFieldMeta[] = [];
    for (const [key, child] of Object.entries(shape)) {
      fields.push(...introspectSchema(child as z.ZodTypeAny, [...prefix, key]));
    }
    return fields;
  }

  if (base instanceof Object && "element" in base) {
    const element = (base as z.ZodArray<z.ZodTypeAny>).element;
    const elementBase = unwrapSchema(element);
    if (elementBase instanceof Object && "shape" in elementBase) {
      const shape = (elementBase as z.ZodObject<z.ZodRawShape>).shape;
      const fields: SchemaFieldMeta[] = [];
      for (const [key, child] of Object.entries(shape)) {
        fields.push(...introspectSchema(child as z.ZodTypeAny, [...prefix, "*", key]));
      }
      return fields;
    }
  }

  return [{ path: prefix, kind: getFieldKind(schema) }];
}

export function extractByPaths(
  data: Record<string, unknown>,
  paths: string[][],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const path of paths) {
    const value = getAtPath(data, path);
    if (value !== undefined) {
      setAtPath(out, path.filter((p) => p !== "*"), value);
    }
  }
  return out;
}

/** Extract frontmatter fields marked as translatable. */
export function pickTranslatable(data: Record<string, unknown>, schema: z.ZodTypeAny): Record<string, unknown> {
  const translatablePaths = introspectSchema(schema)
    .filter((f) => f.kind === "translatable")
    .map((f) => f.path);
  return extractByPaths(data, translatablePaths);
}

/** Extract frontmatter fields marked as structural (EN-only). */
export function pickStructural(data: Record<string, unknown>, schema: z.ZodTypeAny): Record<string, unknown> {
  const structuralPaths = introspectSchema(schema)
    .filter((f) => f.kind === "structural" || f.kind === "relation")
    .map((f) => f.path);
  return extractByPaths(data, structuralPaths);
}

/** Merge EN structural fields onto a locale document's frontmatter at load time. */
export function mergeStructuralOntoLocale(
  localeData: Record<string, unknown>,
  enData: Record<string, unknown>,
  schema: z.ZodTypeAny,
): Record<string, unknown> {
  const structural = pickStructural(enData, schema);
  const translatable = pickTranslatable(localeData, schema);
  return deepMerge(structural, translatable);
}

function getAtPath(obj: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = obj;
  for (const segment of path) {
    if (segment === "*") {
      if (!Array.isArray(current)) return undefined;
      return current.map((item) =>
        typeof item === "object" && item !== null
          ? getAtPath(item as Record<string, unknown>, path.slice(path.indexOf("*") + 1))
          : undefined,
      );
    }
    if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function setAtPath(obj: Record<string, unknown>, path: string[], value: unknown): void {
  if (path.length === 0) return;
  if (path.length === 1) {
    obj[path[0]!] = value;
    return;
  }
  const [head, ...rest] = path;
  if (!(head! in obj) || typeof obj[head!] !== "object" || obj[head!] === null) {
    obj[head!] = {};
  }
  setAtPath(obj[head!] as Record<string, unknown>, rest, value);
}

function deepMerge(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      out[key] &&
      typeof out[key] === "object" &&
      !Array.isArray(out[key])
    ) {
      out[key] = deepMerge(out[key] as Record<string, unknown>, value as Record<string, unknown>);
    } else if (Array.isArray(value) && Array.isArray(out[key])) {
      out[key] = mergeArrayOverlay(out[key] as unknown[], value as unknown[]);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function mergeArrayOverlay(base: unknown[], overlay: unknown[]): unknown[] {
  return base.map((item, index) => {
    const overlayItem = overlay[index];
    if (
      item &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      overlayItem &&
      typeof overlayItem === "object" &&
      !Array.isArray(overlayItem)
    ) {
      return deepMerge(item as Record<string, unknown>, overlayItem as Record<string, unknown>);
    }
    return overlayItem ?? item;
  });
}

/** Collect relation field paths and targets from a content schema. */
export function listRelationFields(schema: z.ZodTypeAny): SchemaFieldMeta[] {
  return introspectSchema(schema).filter((f) => f.kind === "relation");
}
