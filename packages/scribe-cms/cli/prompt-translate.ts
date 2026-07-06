import { CancelPromptError } from "@inquirer/core";
import { checkbox, select } from "@inquirer/prompts";
import type { ScribeConfig } from "../src/core/types.js";

import type { TranslateMode } from "../src/translate/page-translator.js";
import type { TranslationWorklistStrategy } from "../src/translate/worklist.js";

export interface TranslateSelection {
  contentType?: string;
  preset?: string;
  locale?: string[];
  strategy?: TranslationWorklistStrategy;
  mode?: TranslateMode;
}

function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

function nonDefaultLocales(config: ScribeConfig): string[] {
  return config.locales.filter((locale) => locale !== config.defaultLocale);
}

async function runPrompt<T>(prompt: Promise<T>): Promise<T> {
  try {
    return await prompt;
  } catch (error) {
    if (error instanceof CancelPromptError) process.exit(0);
    throw error;
  }
}

async function promptContentType(config: ScribeConfig): Promise<string | undefined> {
  return runPrompt(
    select<string | undefined>({
      message: "Content type to translate",
      choices: [
        { name: "All content types", value: undefined },
        ...config.types.map((type) => ({ name: type.id, value: type.id })),
      ],
    }),
  );
}

/** Sentinel select values that are not preset names. */
const ALL_LOCALES = Symbol("all-locales");
const PICK_LOCALES = Symbol("pick-locales");

async function promptManualLocales(config: ScribeConfig): Promise<Pick<TranslateSelection, "locale">> {
  const locales = nonDefaultLocales(config);
  if (locales.length <= 1) return {};

  const picked = await runPrompt(
    checkbox({
      message: "Locales to translate",
      choices: locales.map((locale) => ({ name: locale, value: locale, checked: true })),
      validate: (values) => values.length > 0 || "Pick at least one locale",
    }),
  );
  return picked.length === locales.length ? {} : { locale: picked };
}

async function promptLocalePreset(config: ScribeConfig): Promise<Pick<TranslateSelection, "preset" | "locale">> {
  const presets = Object.entries(config.localePresets ?? {}).filter(
    (entry): entry is [string, string[]] => Array.isArray(entry[1]),
  );

  if (presets.length === 0) {
    return promptManualLocales(config);
  }

  const choice = await runPrompt(
    select<string | typeof ALL_LOCALES | typeof PICK_LOCALES>({
      message: "Locale preset",
      choices: [
        { name: "All locales", value: ALL_LOCALES },
        ...presets.map(([name, locales]) => ({
          name: `${name} (${locales.join(", ")})`,
          value: name,
        })),
        { name: "Choose locales manually…", value: PICK_LOCALES },
      ],
    }),
  );

  if (choice === PICK_LOCALES) return promptManualLocales(config);
  if (choice === ALL_LOCALES) return {};
  return { preset: choice };
}

async function promptStrategy(): Promise<TranslationWorklistStrategy> {
  return runPrompt(
    select<TranslationWorklistStrategy>({
      message: "Translation strategy",
      choices: [
        { name: "Stale and missing", value: "all" },
        { name: "Missing only (skip stale)", value: "missing-only" },
      ],
      default: "all",
    }),
  );
}

async function promptMode(): Promise<TranslateMode> {
  return runPrompt(
    select<TranslateMode>({
      message: "Translation mode",
      choices: [
        { name: "Batch — 50% cheaper, async, resumable (recommended)", value: "batch" },
        { name: "Direct — immediate results, full price", value: "direct" },
      ],
      default: "batch",
    }),
  );
}

/** Prompt for content type and locale preset when flags are omitted in a TTY. */
export async function promptTranslateSelection(
  config: ScribeConfig,
  flags: {
    type?: string;
    preset?: string;
    locale?: string[];
    strategy?: TranslationWorklistStrategy;
    mode?: TranslateMode;
  },
): Promise<TranslateSelection> {
  const selection: TranslateSelection = {
    contentType: flags.type,
    preset: flags.preset,
    locale: flags.locale,
    strategy: flags.strategy,
    mode: flags.mode,
  };

  if (!isInteractive()) return selection;

  if (!selection.contentType) {
    selection.contentType = await promptContentType(config);
  }

  if (!selection.preset && !selection.locale?.length) {
    Object.assign(selection, await promptLocalePreset(config));
  }

  if (!selection.strategy) {
    selection.strategy = await promptStrategy();
  }

  if (!selection.mode) {
    selection.mode = await promptMode();
  }

  return selection;
}
