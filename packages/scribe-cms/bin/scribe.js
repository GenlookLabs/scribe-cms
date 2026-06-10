#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const pkgRoot = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const builtCli = path.join(pkgRoot, "dist/cli/index.js");

if (!fs.existsSync(builtCli)) {
  const ensureBuilt = path.join(pkgRoot, "bin/ensure-built.mjs");
  const build = spawnSync(process.execPath, [ensureBuilt], {
    stdio: "inherit",
    cwd: pkgRoot,
  });
  if (build.status !== 0 || !fs.existsSync(builtCli)) {
    console.error(
      "scribe-cms could not run: dist/ is missing. Reinstall dependencies or run: pnpm --filter scribe-cms build",
    );
    process.exit(1);
  }
}

const result = spawnSync(process.execPath, [builtCli, ...process.argv.slice(2)], {
  stdio: "inherit",
  cwd: process.cwd(),
});

process.exit(result.status ?? 1);
