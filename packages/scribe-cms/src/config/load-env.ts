import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

const ENV_FILES = [".env", ".env.local"] as const;

/** Load `.env` then `.env.local` from cwd; existing process env wins. */
export function loadEnvFromCwd(cwd: string): void {
  for (const file of ENV_FILES) {
    const envPath = path.join(/* turbopackIgnore: true */ cwd, file);
    if (!fs.existsSync(envPath)) continue;
    dotenv.config({ path: envPath, override: false });
  }
}
