import fs from "node:fs";
import path from "node:path";
import type { ContentTypeConfig, ScribeConfig } from "../core/types.js";
import {
  parseRedirectEntry,
  type ParsedRedirectEntry,
  typeRedirectsFileSchema,
} from "./redirect-schema.js";

export const TYPE_REDIRECTS_FILENAME = "_redirects.json";

export interface LoadedTypeRedirects {
  contentTypeId: string;
  contentDir: string;
  filePath: string;
  entries: ParsedRedirectEntry[];
}

function redirectsFilePath(config: ScribeConfig, type: ContentTypeConfig): string {
  return path.join(config.rootDir, type.contentDir, TYPE_REDIRECTS_FILENAME);
}

export function loadTypeRedirectsFile(
  config: ScribeConfig,
  type: ContentTypeConfig,
): LoadedTypeRedirects | null {
  const filePath = redirectsFilePath(config, type);
  if (!fs.existsSync(filePath)) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(
      `${type.id}: failed to parse ${TYPE_REDIRECTS_FILENAME}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const parsed = typeRedirectsFileSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
      .join("; ");
    throw new Error(`${type.id}: invalid ${TYPE_REDIRECTS_FILENAME}: ${details}`);
  }

  return {
    contentTypeId: type.id,
    contentDir: type.contentDir,
    filePath,
    entries: parsed.data.redirects.map(parseRedirectEntry),
  };
}

export function loadAllTypeRedirects(config: ScribeConfig): LoadedTypeRedirects[] {
  const out: LoadedTypeRedirects[] = [];
  for (const type of config.types) {
    const loaded = loadTypeRedirectsFile(config, type);
    if (loaded) out.push(loaded);
  }
  return out;
}

export function collectRedirectSourceSlugs(loaded: LoadedTypeRedirects[]): Set<string> {
  const slugs = new Set<string>();
  for (const file of loaded) {
    for (const entry of file.entries) {
      for (const from of entry.fromSlugs) {
        slugs.add(from);
      }
    }
  }
  return slugs;
}

export function collectOutboundRedirectSourcesByType(
  loaded: LoadedTypeRedirects[],
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const file of loaded) {
    const set = out.get(file.contentTypeId) ?? new Set<string>();
    for (const entry of file.entries) {
      for (const from of entry.fromSlugs) {
        set.add(from);
      }
    }
    out.set(file.contentTypeId, set);
  }
  return out;
}
