import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import type { ContentTypeConfig, ScribeConfig } from "./types.js";
import { isPublishableContentFile } from "../loader/normalize-en.js";
import { listTranslationsForEnSlug } from "../storage/translations.js";

export function enFileExists(
  config: ScribeConfig,
  type: ContentTypeConfig,
  enSlug: string,
): boolean {
  const dir = path.join(config.rootDir, type.contentDir);
  return (
    fs.existsSync(path.join(dir, `${enSlug}.mdx`)) ||
    fs.existsSync(path.join(dir, `${enSlug}.md`))
  );
}

export function sqliteHasTranslations(
  db: Database.Database,
  contentTypeId: string,
  enSlug: string,
): boolean {
  return listTranslationsForEnSlug(db, contentTypeId, enSlug).length > 0;
}

export function isAliasKnown(
  config: ScribeConfig,
  type: ContentTypeConfig,
  aliasEnSlug: string,
  db: Database.Database,
): boolean {
  return enFileExists(config, type, aliasEnSlug) || sqliteHasTranslations(db, type.id, aliasEnSlug);
}

export function listEnSlugs(rootDir: string, contentDir: string): string[] {
  const dir = path.join(rootDir, contentDir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter(isPublishableContentFile)
    .map((f) => f.replace(/\.(md|mdx)$/, ""));
}
