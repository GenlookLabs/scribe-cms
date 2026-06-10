#!/usr/bin/env node
import { createProject, loadConfigSync, translateWorklist, validateProject } from "../src/index.js";
import { listRevisions } from "../src/storage/translations.js";
import { loadEnvFromCwd } from "../src/config/load-env.js";
import { buildWorklist, resolveLocalesFromPreset } from "../src/translate/worklist.js";
import { startStudio } from "../studio/server.js";
import { promptTranslateSelection } from "./prompt-translate.js";
import { createTranslateProgressReporter } from "./translate-progress.js";

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
  concurrency?: number;
  noProgress?: boolean;
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
    if (arg === "--concurrency") {
      options.concurrency = Number(argv[++i]);
      i++;
      continue;
    }
    if (arg === "--no-progress") {
      options.noProgress = true;
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

Translate flags:
  --type <id>            Content type (interactive picker in a TTY when omitted)
  --preset <name>        Locale preset from config (interactive picker in a TTY)
  --locale <code>...     Target locale(s); overrides --preset
  --slug <en-slug>       Single English document
  --model <id>           Gemini model override
  --concurrency <n>      Parallel translations (default: 3)
  --dry-run              List work without writing
  --force                Re-translate even when hashes match
  --no-progress          Plain line logging instead of live progress
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
      const selection = await promptTranslateSelection(config, {
        type: options.type,
        preset: options.preset,
        locale: options.locale,
      });
      const locales = resolveLocalesFromPreset(config, selection.preset, selection.locale);
      const worklist = buildWorklist(config, {
        contentType: selection.contentType,
        locales,
        enSlug: options.slug,
      });
      if (worklist.length === 0) {
        console.log("Nothing to translate.");
        break;
      }

      const reporter = createTranslateProgressReporter({
        enabled: !options.noProgress,
        dryRun: options.dryRun,
      });

      const results = await translateWorklist(config, worklist, {
        model: options.model,
        dryRun: options.dryRun,
        force: options.force,
        concurrency: options.concurrency,
        onProgress: reporter.onEvent,
      });
      reporter.finish();

      const failed = results.filter((result) => result.failed);
      if (failed.length > 0) process.exitCode = 1;
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
