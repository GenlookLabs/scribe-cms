import type { ScribeConfig } from "../core/types.js";
import { computeBodyHash } from "../hash/page-hash.js";
import { openStore } from "../storage/sqlite.js";
import { appendRevision } from "../storage/translations.js";

/** Append a revision row to the SQLite store. */
export function recordRevision(
  config: ScribeConfig,
  input: {
    contentType: string;
    enSlug: string;
    locale: string | null;
    revisionKind: "translation" | "en_edit_detected" | "snapshot";
    enHash: string;
    body: string;
    model?: string;
    /** Translated frontmatter to snapshot alongside the body. */
    frontmatter?: Record<string, unknown>;
  },
): number {
  const db = openStore(config, "readwrite");
  const id = appendRevision(db, {
    contentType: input.contentType,
    enSlug: input.enSlug,
    locale: input.locale,
    revisionKind: input.revisionKind,
    enHash: input.enHash,
    bodyHash: computeBodyHash(input.body),
    createdAt: new Date().toISOString(),
    model: input.model,
    bodyPreview: input.body.slice(0, 200),
    frontmatterJson: input.frontmatter ? JSON.stringify(input.frontmatter) : null,
    body: input.body,
  });
  db.close();
  return id;
}
