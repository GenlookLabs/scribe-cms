import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Package version from the nearest `scribe-cms` package.json (works from source or dist). */
export function readScribeVersion(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = path.join(dir, "package.json");
    if (fs.existsSync(candidate)) {
      const pkg = JSON.parse(fs.readFileSync(candidate, "utf8")) as {
        name?: string;
        version?: string;
      };
      if (pkg.name === "scribe-cms" && pkg.version) return pkg.version;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "unknown";
}

export const SCRIBE_VERSION = readScribeVersion();
