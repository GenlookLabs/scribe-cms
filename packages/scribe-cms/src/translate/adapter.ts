import type { ScribeConfig } from "../core/types.js";

/** Env var read for the translation API key when the config doesn't set one. */
export const TRANSLATE_API_KEY_ENV = "SCRIBE_TRANSLATE_API_KEY";

/** Legacy env var, still read after `SCRIBE_TRANSLATE_API_KEY`. */
const LEGACY_GEMINI_KEY_ENV = "GEMINI_API_KEY";

export interface GeminiAdapterOptions {
  /** Model display name or API id, e.g. `"gemini-3.8-flash"`. Defaults to Scribe's default model. */
  model?: string;
  /**
   * API key. Usually read from the environment in `scribe.config.ts`
   * (`process.env.MY_KEY`); `.env` and `.env.local` are loaded before the config.
   * Falls back to `SCRIBE_TRANSLATE_API_KEY`, then `GEMINI_API_KEY`.
   */
  apiKey?: string;
}

/** Translation backend selected in `translate.adapter`. Gemini is the only provider today. */
export interface TranslateAdapter {
  provider: "gemini";
  model?: string;
  apiKey?: string;
}

/** Gemini translation adapter for `translate.adapter` in `scribe.config.ts`. */
export function gemini(options: GeminiAdapterOptions = {}): TranslateAdapter {
  return { provider: "gemini", model: options.model, apiKey: options.apiKey };
}

/** API key for translation calls: config adapter, then env. Throws when none is set. */
export function resolveTranslateApiKey(config: Pick<ScribeConfig, "translate">): string {
  const key =
    config.translate?.adapter?.apiKey ||
    process.env[TRANSLATE_API_KEY_ENV] ||
    process.env[LEGACY_GEMINI_KEY_ENV];
  if (!key) {
    throw new Error(
      `No translation API key: set translate.adapter apiKey in scribe.config.ts, or ${TRANSLATE_API_KEY_ENV} (or ${LEGACY_GEMINI_KEY_ENV}) in the environment.`,
    );
  }
  return key;
}
