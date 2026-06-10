#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const pkgRoot = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const builtCli = path.join(pkgRoot, "dist/cli/index.js");

if (fs.existsSync(builtCli)) {
  process.exit(0);
}

console.log("scribe-cms: building from source…");

for (const [command, args] of [
  ["pnpm", ["run", "build"]],
  ["npm", ["run", "build"]],
]) {
  const result = spawnSync(command, args, {
    cwd: pkgRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status === 0 && fs.existsSync(builtCli)) {
    process.exit(0);
  }
}

console.error("scribe-cms: failed to build dist/. Install devDependencies or run: pnpm --filter scribe-cms build");
process.exit(1);
