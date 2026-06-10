import { CancelPromptError } from "@inquirer/core";
import { checkbox, select } from "@inquirer/prompts";
import type { ScribeConfig } from "../src/core/types.js";

export interface TranslateSelection {
  contentType?: string;
  preset?: string;
  locale?: string[];
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

async function promptLocalePreset(config: ScribeConfig): Promise<Pick<TranslateSelection, "preset" | "locale">> {
  const presets = Object.entries(config.localePresets ?? {}).filter(
    (entry): entry is [string, string[]] => Array.isArray(entry[1]),
  );

  if (presets.length === 0) {
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

  const choice = await runPrompt(
    select<string | undefined>({
      message: "Locale preset",
      choices: [
        { name: "All locales", value: undefined },
        ...presets.map(([name, locales]) => ({
          name: `${name} (${locales.join(", ")})`,
          value: name,
        })),
      ],
    }),
  );
  return choice ? { preset: choice } : {};
}

/** Prompt for content type and locale preset when flags are omitted in a TTY. */
export async function promptTranslateSelection(
  config: ScribeConfig,
  flags: { type?: string; preset?: string; locale?: string[] },
): Promise<TranslateSelection> {
  const selection: TranslateSelection = {
    contentType: flags.type,
    preset: flags.preset,
    locale: flags.locale,
  };

  if (!isInteractive()) return selection;

  if (!selection.contentType) {
    selection.contentType = await promptContentType(config);
  }

  if (!selection.preset && !selection.locale?.length) {
    Object.assign(selection, await promptLocalePreset(config));
  }

  return selection;
}
