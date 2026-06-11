import type Database from "better-sqlite3";
import type { ScribeConfig } from "../core/types.js";
import { openStore } from "../storage/sqlite.js";
import { getOrCreateEnSnapshot } from "../storage/translations.js";

/** Record (or reuse) a deduplicated EN-source snapshot for a translation run. */
export function recordEnSnapshot(
  config: ScribeConfig,
  input: {
    contentType: string;
    enSlug: string;
    enHash: string;
    frontmatter: Record<string, unknown>;
    body: string;
  },
  db?: Database.Database,
): number {
  const ownDb = db ?? openStore(config, "readwrite");
  const id = getOrCreateEnSnapshot(ownDb, {
    contentType: input.contentType,
    enSlug: input.enSlug,
    enHash: input.enHash,
    frontmatter: input.frontmatter,
    body: input.body,
    createdAt: new Date().toISOString(),
  });
  if (!db) ownDb.close();
  return id;
}
