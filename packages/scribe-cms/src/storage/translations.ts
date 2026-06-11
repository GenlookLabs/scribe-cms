import type Database from "better-sqlite3";

export interface TranslationRow {
  content_type: string;
  en_slug: string;
  locale: string;
  slug: string;
  frontmatter_json: string;
  body: string;
  en_hash: string;
  translated_at: string;
  model: string;
  snapshot_id: number | null;
}

export interface TranslationInput {
  contentType: string;
  enSlug: string;
  locale: string;
  slug: string;
  frontmatter: Record<string, unknown>;
  body: string;
  enHash: string;
  translatedAt: string;
  model: string;
  snapshotId: number;
}

export interface EnSnapshotInput {
  contentType: string;
  enSlug: string;
  enHash: string;
  frontmatter: Record<string, unknown>;
  body: string;
  createdAt: string;
}

export interface EnSnapshotRow {
  id: number;
  content_type: string;
  en_slug: string;
  en_hash: string;
  frontmatter_json: string;
  body: string;
  created_at: string;
}

export interface EnSnapshotWithLocales extends EnSnapshotRow {
  locales: string;
}

export function getOrCreateEnSnapshot(db: Database.Database, input: EnSnapshotInput): number {
  db.prepare(
    `INSERT OR IGNORE INTO en_snapshots (
      content_type, en_slug, en_hash, frontmatter_json, body, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    input.contentType,
    input.enSlug,
    input.enHash,
    JSON.stringify(input.frontmatter),
    input.body,
    input.createdAt,
  );

  const row = db
    .prepare(
      `SELECT id FROM en_snapshots
       WHERE content_type = ? AND en_slug = ? AND en_hash = ?`,
    )
    .get(input.contentType, input.enSlug, input.enHash) as { id: number };

  return row.id;
}

export function getEnSnapshot(
  db: Database.Database,
  snapshotId: number,
): EnSnapshotRow | undefined {
  return db
    .prepare(`SELECT * FROM en_snapshots WHERE id = ?`)
    .get(snapshotId) as EnSnapshotRow | undefined;
}

export function listEnSnapshotsForEnSlug(
  db: Database.Database,
  contentType: string,
  enSlug: string,
): EnSnapshotWithLocales[] {
  return db
    .prepare(
      `SELECT s.*, GROUP_CONCAT(t.locale) AS locales
       FROM en_snapshots s
       LEFT JOIN translations t ON t.snapshot_id = s.id
       WHERE s.content_type = ? AND s.en_slug = ?
       GROUP BY s.id
       ORDER BY s.created_at DESC, s.id DESC`,
    )
    .all(contentType, enSlug) as EnSnapshotWithLocales[];
}

export function upsertTranslation(db: Database.Database, input: TranslationInput): void {
  db.prepare(
    `INSERT INTO translations (
      content_type, en_slug, locale, slug, frontmatter_json, body, en_hash, translated_at, model, snapshot_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(content_type, en_slug, locale) DO UPDATE SET
      slug = excluded.slug,
      frontmatter_json = excluded.frontmatter_json,
      body = excluded.body,
      en_hash = excluded.en_hash,
      translated_at = excluded.translated_at,
      model = excluded.model,
      snapshot_id = excluded.snapshot_id`,
  ).run(
    input.contentType,
    input.enSlug,
    input.locale,
    input.slug,
    JSON.stringify(input.frontmatter),
    input.body,
    input.enHash,
    input.translatedAt,
    input.model,
    input.snapshotId,
  );
}

export function getTranslation(
  db: Database.Database,
  contentType: string,
  enSlug: string,
  locale: string,
): TranslationRow | undefined {
  return db
    .prepare(
      `SELECT * FROM translations WHERE content_type = ? AND en_slug = ? AND locale = ?`,
    )
    .get(contentType, enSlug, locale) as TranslationRow | undefined;
}

export function listTranslationsForType(
  db: Database.Database,
  contentType: string,
): TranslationRow[] {
  return db
    .prepare(`SELECT * FROM translations WHERE content_type = ? ORDER BY en_slug, locale`)
    .all(contentType) as TranslationRow[];
}

export function listTranslationsForEnSlug(
  db: Database.Database,
  contentType: string,
  enSlug: string,
): TranslationRow[] {
  return db
    .prepare(
      `SELECT * FROM translations WHERE content_type = ? AND en_slug = ? ORDER BY locale`,
    )
    .all(contentType, enSlug) as TranslationRow[];
}

export function listTranslationsForLocale(
  db: Database.Database,
  contentType: string,
  locale: string,
): TranslationRow[] {
  return db
    .prepare(`SELECT * FROM translations WHERE content_type = ? AND locale = ? ORDER BY en_slug`)
    .all(contentType, locale) as TranslationRow[];
}

export function bulkLoadTranslations(db: Database.Database): TranslationRow[] {
  return db.prepare(`SELECT * FROM translations ORDER BY content_type, en_slug, locale`).all() as TranslationRow[];
}

export function countTranslations(db: Database.Database): number {
  const row = db.prepare(`SELECT COUNT(*) as count FROM translations`).get() as { count: number };
  return row.count;
}

export function countStaleTranslations(
  db: Database.Database,
  contentType: string,
  enSlug: string,
  currentEnHash: string,
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) as count FROM translations
       WHERE content_type = ? AND en_slug = ? AND en_hash != ?`,
    )
    .get(contentType, enSlug, currentEnHash) as { count: number };
  return row.count;
}
