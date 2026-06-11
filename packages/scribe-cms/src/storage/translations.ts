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
}

export interface RevisionInput {
  contentType: string;
  enSlug: string;
  locale: string | null;
  revisionKind: "translation" | "en_edit_detected" | "snapshot";
  enHash: string;
  bodyHash: string;
  createdAt: string;
  model?: string;
  bodyPreview?: string;
  /** Full translated frontmatter snapshot (JSON) at revision time. */
  frontmatterJson?: string | null;
  /** Full translated body snapshot at revision time. */
  body?: string | null;
}

export interface RevisionRow {
  id: number;
  content_type: string;
  en_slug: string;
  locale: string | null;
  revision_kind: string;
  en_hash: string;
  body_hash: string;
  created_at: string;
  model: string | null;
  body_preview: string | null;
  frontmatter_json: string | null;
  body: string | null;
}

export function upsertTranslation(db: Database.Database, input: TranslationInput): void {
  db.prepare(
    `INSERT INTO translations (
      content_type, en_slug, locale, slug, frontmatter_json, body, en_hash, translated_at, model
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(content_type, en_slug, locale) DO UPDATE SET
      slug = excluded.slug,
      frontmatter_json = excluded.frontmatter_json,
      body = excluded.body,
      en_hash = excluded.en_hash,
      translated_at = excluded.translated_at,
      model = excluded.model`,
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

export function appendRevision(db: Database.Database, input: RevisionInput): number {
  const result = db
    .prepare(
      `INSERT INTO revisions (
        content_type, en_slug, locale, revision_kind, en_hash, body_hash, created_at,
        model, body_preview, frontmatter_json, body
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.contentType,
      input.enSlug,
      input.locale,
      input.revisionKind,
      input.enHash,
      input.bodyHash,
      input.createdAt,
      input.model ?? null,
      input.bodyPreview ?? null,
      input.frontmatterJson ?? null,
      input.body ?? null,
    );
  return Number(result.lastInsertRowid);
}

/** List revision history for an EN slug, optionally filtered by locale. */
export function listRevisions(
  db: Database.Database,
  contentType: string,
  enSlug: string,
  locale?: string,
): RevisionRow[] {
  if (locale) {
    return db
      .prepare(
        `SELECT * FROM revisions
         WHERE content_type = ? AND en_slug = ? AND locale = ?
         ORDER BY created_at DESC, id DESC`,
      )
      .all(contentType, enSlug, locale) as RevisionRow[];
  }
  return db
    .prepare(
      `SELECT * FROM revisions
       WHERE content_type = ? AND en_slug = ?
       ORDER BY created_at DESC, id DESC`,
    )
    .all(contentType, enSlug) as RevisionRow[];
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
