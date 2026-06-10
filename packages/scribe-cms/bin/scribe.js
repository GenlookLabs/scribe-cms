#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const pkgRoot = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const builtCli = path.join(pkgRoot, "dist/cli/index.js");

if (!fs.existsSync(builtCli)) {
  console.error("scribe-cms is not built.");
  process.exit(1);
}

const result = spawnSync(process.execPath, [builtCli, ...process.argv.slice(2)], {
  stdio: "inherit",
  cwd: process.cwd(),
});

process.exit(result.status ?? 1);
