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
  });
  db.close();
  return id;
}
