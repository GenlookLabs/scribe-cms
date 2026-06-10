#!/usr/bin/env node
import { createProject, loadConfigSync, translateWorklist, validateProject } from "../src/index.js";
import { listRevisions } from "../src/storage/translations.js";
import { loadEnvFromCwd } from "../src/config/load-env.js";
import { buildWorklist, resolveLocalesFromPreset } from "../src/translate/worklist.js";
import { startStudio } from "../studio/server.js";

interface CliOptions {
  config?: string;
  cwd: string;
  locale?: string[];
  preset?: string;
  type?: string;
  slug?: string;
  model?: string;
  dryRun?: boolean;
  force?: boolean;
  port?: number;
}

function parseArgs(argv: string[]): { command: string; options: CliOptions; rest: string[] } {
  const options: CliOptions = { cwd: process.cwd() };
  const positional: string[] = [];
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    if (arg === "--config") {
      options.config = argv[++i];
      i++;
      continue;
    }
    if (arg === "--locale") {
      const locales: string[] = [];
      while (argv[i + 1] && !argv[i + 1]!.startsWith("--")) {
        locales.push(argv[++i]!);
      }
      options.locale = locales;
      i++;
      continue;
    }
    if (arg === "--preset") {
      options.preset = argv[++i];
      i++;
      continue;
    }
    if (arg === "--type") {
      options.type = argv[++i];
      i++;
      continue;
    }
    if (arg === "--slug") {
      options.slug = argv[++i];
      i++;
      continue;
    }
    if (arg === "--model") {
      options.model = argv[++i];
      i++;
      continue;
    }
    if (arg === "--port") {
      options.port = Number(argv[++i]);
      i++;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      i++;
      continue;
    }
    if (arg === "--force") {
      options.force = true;
      i++;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`Unknown flag: ${arg}`);
    }
    positional.push(arg);
    i++;
  }
  const [command = "help", ...rest] = positional;
  return { command, options, rest };
}

function loadProject(options: CliOptions) {
  const config = loadConfigSync({
    cwd: options.cwd,
    configPath: options.config,
  });
  return createProject(config);
}

async function main(): Promise<void> {
  const { command, options, rest } = parseArgs(process.argv.slice(2));
  loadEnvFromCwd(options.cwd);

  if (command === "help" || command === "--help") {
    console.log(`Usage: scribe <command>

Commands:
  status                 Show EN docs + translation counts
  validate               Validate EN files and sqlite consistency
  translate              Translate stale/missing locale pages
  history <type> <slug>  Show revision timeline
  studio                 Start read-only local studio
`);
    return;
  }

  const project = loadProject(options);
  const config = project.config;

  switch (command) {
    case "status": {
      for (const type of project.listTypes()) {
        const enCount = type.list().length;
        console.log(`${type.id}: ${enCount} EN docs`);
        for (const locale of config.locales) {
          if (locale === config.defaultLocale) continue;
          const count = type.load().get(locale)?.bySlug.size ?? 0;
          console.log(`  ${locale}: ${count}`);
        }
      }
      console.log(`store: ${project.storePath}`);
      break;
    }
    case "validate": {
      const result = validateProject(config);
      for (const issue of result.issues) {
        console.log(
          `[${issue.level}] ${issue.contentType ?? ""} ${issue.enSlug ?? ""} ${issue.locale ?? ""} ${issue.message}`,
        );
      }
      if (!result.ok) process.exitCode = 1;
      break;
    }
    case "translate": {
      const locales = resolveLocalesFromPreset(config, options.preset, options.locale);
      const worklist = buildWorklist(config, {
        contentType: options.type,
        locales,
        enSlug: options.slug,
      });
      console.log(`Translating ${worklist.length} page(s)...`);
      const results = await translateWorklist(config, worklist, {
        model: options.model,
        dryRun: options.dryRun,
        force: options.force,
      });
      for (const result of results) {
        console.log(
          `${result.contentType}/${result.enSlug}@${result.locale}: ${result.skipped ? "skipped" : "translated"}${result.model ? ` (${result.model})` : ""}`,
        );
      }
      break;
    }
    case "history": {
      const [typeId, enSlug, locale] = rest;
      if (!typeId || !enSlug) {
        throw new Error("Usage: scribe history <type> <en-slug> [locale]");
      }
      const { openStore } = await import("../src/storage/sqlite.js");
      const db = openStore(config, "readonly");
      const rows = listRevisions(db, typeId, enSlug, locale);
      db.close();
      for (const row of rows) {
        console.log(
          `${row.created_at} ${row.revision_kind} locale=${row.locale ?? "en"} en_hash=${row.en_hash.slice(0, 8)} body_hash=${row.body_hash.slice(0, 8)}`,
        );
      }
      break;
    }
    case "studio": {
      await startStudio(project, { port: options.port ?? 3600 });
      break;
    }
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
