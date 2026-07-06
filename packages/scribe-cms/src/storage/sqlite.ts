import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { ScribeConfig } from "../core/types.js";

const SCHEMA_VERSION = 5;

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
  `CREATE TABLE IF NOT EXISTS en_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content_type TEXT NOT NULL,
    en_slug TEXT NOT NULL,
    en_hash TEXT NOT NULL,
    frontmatter_json TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (content_type, en_slug, en_hash)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_en_snapshots_lookup
    ON en_snapshots(content_type, en_slug, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS translation_batch_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_name TEXT NOT NULL UNIQUE,
    model TEXT NOT NULL,
    display_model TEXT NOT NULL,
    created_at TEXT NOT NULL,
    state TEXT NOT NULL,
    completed_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS translation_batch_items (
    job_id INTEGER NOT NULL,
    request_index INTEGER NOT NULL,
    content_type TEXT NOT NULL,
    en_slug TEXT NOT NULL,
    locale TEXT NOT NULL,
    en_hash TEXT NOT NULL,
    snapshot_id INTEGER NOT NULL,
    status TEXT NOT NULL,
    error TEXT,
    PRIMARY KEY (job_id, request_index)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_batch_items_status
    ON translation_batch_items(status)`,
];

export type SqliteMode = "readonly" | "readwrite";

/** Absolute path to the SQLite translation store (precomputed by `resolveConfig`). */
export function resolveStorePath(config: ScribeConfig): string {
  return config.storePath;
}

/** Open the SQLite translation store (creates schema if missing). */
export function openStore(config: ScribeConfig, mode: SqliteMode = "readwrite"): Database.Database {
  const storePath = resolveStorePath(config);
  if (mode === "readwrite") {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
  }
  const db = new Database(storePath, { readonly: mode === "readonly" });
  if (mode === "readwrite") {
    migrate(db);
  }
  return db;
}

function addColumnIfMissing(
  db: Database.Database,
  table: string,
  column: string,
  ddlType: string,
): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddlType}`);
  }
}

function readSchemaVersion(db: Database.Database): number {
  const metaTable = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'`)
    .get();
  if (!metaTable) return 0;
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
    | { value: string }
    | undefined;
  return row ? Number.parseInt(row.value, 10) || 0 : 0;
}

function migrate(db: Database.Database): void {
  const previousVersion = readSchemaVersion(db);

  for (const sql of MIGRATIONS) {
    db.exec(sql);
  }

  if (previousVersion < 4) {
    db.exec(`DROP TABLE IF EXISTS revisions`);
  }

  addColumnIfMissing(db, "translations", "snapshot_id", "INTEGER");

  db.prepare(
    `INSERT INTO meta(key, value) VALUES('schema_version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(String(SCHEMA_VERSION));
}

export function closeStore(db: Database.Database): void {
  db.close();
}
