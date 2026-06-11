import fs from "node:fs";
import path from "node:path";
import type { ScribeProject } from "../core/types.js";
import {
  buildStaticRawExports,
  getStaticExportRoots,
  type BuildStaticRawExportsOptions,
} from "./build-static-raw-exports.js";

export interface WriteStaticRawExportsOptions extends BuildStaticRawExportsOptions {
  /** Output directory (typically `public`). Default `public`. */
  outDir?: string;
}

function rmDirIfExists(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Remove managed export roots, write fresh static raw MDX files, return exports written. */
export function writeStaticRawExports(
  project: ScribeProject,
  options: WriteStaticRawExportsOptions = {},
): { exports: ReturnType<typeof buildStaticRawExports>; written: number } {
  const outDir = path.resolve(options.outDir ?? "public");
  const typeFilter = options.types;

  for (const root of getStaticExportRoots(project, {
    types: typeFilter,
    locales: options.locales,
  })) {
    rmDirIfExists(path.join(outDir, root));
  }

  const exports = buildStaticRawExports(project, options);
  const counts = new Map<string, number>();

  for (const item of exports) {
    const filePath = path.join(outDir, item.relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, item.source, "utf8");
    const key = `${item.typeId}/${item.locale}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  for (const [key, count] of [...counts.entries()].sort()) {
    console.log(`  ${key}: ${count}`);
  }

  return { exports, written: exports.length };
}
