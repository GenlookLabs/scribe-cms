import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { ScribeConfig } from "../core/types.js";

const SCHEMA_VERSION = 2;

const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS translations (
    content_type TEXT NOT NULL,
    en_slug TEXT NOT NULL,
    locale TEXT NOT NULL,
    slug TEXT NOT NULL,
    frontmatter_json TEXT NOT NULL,
    body TEXT NOT NULL,
    en_hash TEXT NOT NULL,
    translated_at TEXT NOT NULL,
    model TEXT NOT NULL,
    PRIMARY KEY (content_type, en_slug, locale)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_translations_type_locale
    ON translations(content_type, locale)`,
  `CREATE TABLE IF NOT EXISTS revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content_type TEXT NOT NULL,
    en_slug TEXT NOT NULL,
    locale TEXT,
    revision_kind TEXT NOT NULL,
    en_hash TEXT NOT NULL,
    body_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    model TEXT,
    body_preview TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_revisions_lookup
    ON revisions(content_type, en_slug, locale, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS slug_aliases (
    content_type TEXT NOT NULL,
    canonical_en_slug TEXT NOT NULL,
    alias_en_slug TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (content_type, alias_en_slug)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_slug_aliases_canonical
    ON slug_aliases(content_type, canonical_en_slug)`,
  `CREATE TABLE IF NOT EXISTS alias_locale_slugs (
    content_type TEXT NOT NULL,
    alias_en_slug TEXT NOT NULL,
    locale TEXT NOT NULL,
    locale_slug TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    PRIMARY KEY (content_type, alias_en_slug, locale)
  )`,
];

export type SqliteMode = "readonly" | "readwrite";

/** Absolute path to the SQLite translation store (precomputed by `resolveConfig`). */
export function resolveStorePath(config: ScribeConfig): string {
  return config.storePath;
}

/** Open the SQLite translation store (creates schema if missing). */
export function openStore(config: ScribeConfig, mode: SqliteMode = "readwrite"): Database.Database {
  const storePath = resolveStorePath(config);
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const db = new Database(storePath, { readonly: mode === "readonly" });
  if (mode === "readwrite") {
    migrate(db);
  }
  return db;
}

function migrate(db: Database.Database): void {
  for (const sql of MIGRATIONS) {
    db.exec(sql);
  }
  db.prepare(
    `INSERT INTO meta(key, value) VALUES('schema_version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(String(SCHEMA_VERSION));
}

export function closeStore(db: Database.Database): void {
  db.close();
}
