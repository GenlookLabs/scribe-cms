import type Database from "better-sqlite3";

export type BatchItemStatus = "pending" | "done" | "failed" | "stale-skipped";

export interface BatchJobRow {
  id: number;
  job_name: string;
  model: string;
  display_model: string;
  created_at: string;
  state: string;
  completed_at: string | null;
}

export interface BatchItemRow {
  job_id: number;
  request_index: number;
  content_type: string;
  en_slug: string;
  locale: string;
  en_hash: string;
  snapshot_id: number;
  status: BatchItemStatus;
  error: string | null;
}

export interface BatchJobInput {
  jobName: string;
  model: string;
  displayModel: string;
  state: string;
  createdAt: string;
}

export interface BatchItemInput {
  requestIndex: number;
  contentType: string;
  enSlug: string;
  locale: string;
  enHash: string;
  snapshotId: number;
}

export function insertBatchJob(db: Database.Database, input: BatchJobInput): number {
  const info = db
    .prepare(
      `INSERT INTO translation_batch_jobs (job_name, model, display_model, created_at, state)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(input.jobName, input.model, input.displayModel, input.createdAt, input.state);
  return Number(info.lastInsertRowid);
}

export function insertBatchItems(
  db: Database.Database,
  jobId: number,
  items: BatchItemInput[],
): void {
  const stmt = db.prepare(
    `INSERT INTO translation_batch_items (
      job_id, request_index, content_type, en_slug, locale, en_hash, snapshot_id, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
  );
  for (const item of items) {
    stmt.run(
      jobId,
      item.requestIndex,
      item.contentType,
      item.enSlug,
      item.locale,
      item.enHash,
      item.snapshotId,
    );
  }
}

/** Jobs not yet fully ingested (no completed_at), oldest first. */
export function listPendingBatchJobs(db: Database.Database): BatchJobRow[] {
  return db
    .prepare(`SELECT * FROM translation_batch_jobs WHERE completed_at IS NULL ORDER BY id`)
    .all() as BatchJobRow[];
}

export function listBatchItems(db: Database.Database, jobId: number): BatchItemRow[] {
  return db
    .prepare(`SELECT * FROM translation_batch_items WHERE job_id = ? ORDER BY request_index`)
    .all(jobId) as BatchItemRow[];
}

/** Pending items across all non-completed jobs (i.e. requests still in flight). */
export function listPendingBatchItems(db: Database.Database): BatchItemRow[] {
  return db
    .prepare(
      `SELECT i.* FROM translation_batch_items i
       JOIN translation_batch_jobs j ON j.id = i.job_id
       WHERE j.completed_at IS NULL AND i.status = 'pending'
       ORDER BY i.job_id, i.request_index`,
    )
    .all() as BatchItemRow[];
}

/**
 * Atomically claim a terminal job for ingestion by stamping completed_at.
 * Returns false when another process already completed it — concurrent scribe
 * runs adopt each other's pending jobs, so two pollers can reach the same
 * terminal job; only the one whose claim succeeds may ingest its results.
 */
export function claimBatchJobCompletion(
  db: Database.Database,
  jobId: number,
  state: string,
  completedAt: string,
): boolean {
  const info = db
    .prepare(
      `UPDATE translation_batch_jobs SET state = ?, completed_at = ?
       WHERE id = ? AND completed_at IS NULL`,
    )
    .run(state, completedAt, jobId);
  return info.changes > 0;
}

export function updateBatchItemStatus(
  db: Database.Database,
  jobId: number,
  requestIndex: number,
  status: BatchItemStatus,
  error?: string,
): void {
  db.prepare(
    `UPDATE translation_batch_items SET status = ?, error = ? WHERE job_id = ? AND request_index = ?`,
  ).run(status, error ?? null, jobId, requestIndex);
}
