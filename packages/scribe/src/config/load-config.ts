import fs from "node:fs";
import path from "node:path";
import { createJiti } from "jiti";
import type { ScribeConfig, ScribeConfigInput } from "../core/types.js";
import { resolveConfig } from "./resolve-config.js";

export interface LoadConfigOptions {
  configPath?: string;
  cwd?: string;
}

/** Find scribe.config.ts/mts/js in a directory. */
export function findConfigPath(cwd: string): string | null {
  const candidates = [
    path.join(/* turbopackIgnore: true */ cwd, "scribe.config.ts"),
    path.join(/* turbopackIgnore: true */ cwd, "scribe.config.mts"),
    path.join(/* turbopackIgnore: true */ cwd, "scribe.config.js"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

/** Load and resolve scribe.config.ts synchronously (CLI). */
export function loadConfigSync(options: LoadConfigOptions = {}): ScribeConfig {
  const cwd = options.cwd ?? /* turbopackIgnore: true */ process.cwd();
  const configPath = options.configPath ?? findConfigPath(cwd);
  if (!configPath) {
    throw new Error(`No scribe.config.ts found in ${cwd} (pass --config)`);
  }

  const jiti = createJiti(import.meta.url, {
    interopDefault: true,
    moduleCache: false,
  });

  const loaded = jiti(configPath) as ScribeConfigInput | { default: ScribeConfigInput };
  const config = "default" in loaded ? loaded.default : loaded;
  if (!config?.rootDir) {
    throw new Error(`Invalid scribe config at ${configPath}: missing rootDir`);
  }
  return resolveConfig(config, path.dirname(configPath));
}
