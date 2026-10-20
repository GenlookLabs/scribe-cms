import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { gemini, resolveTranslateApiKey } from "./adapter.js";
import { resolveTranslateConfig } from "./resolve-translate-config.js";
import { DEFAULT_GEMINI_MODEL } from "./gemini-models.js";
import type { ContentTypeConfig, ScribeConfig } from "../core/types.js";

const ENV_KEYS = ["SCRIBE_TRANSLATE_API_KEY", "GEMINI_API_KEY"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

describe("resolveTranslateApiKey", () => {
  it("prefers the adapter key over the environment", () => {
    process.env.SCRIBE_TRANSLATE_API_KEY = "env-generic";
    assert.equal(resolveTranslateApiKey({ translate: { adapter: gemini({ apiKey: "from-config" }) } }), "from-config");
  });

  it("falls back to SCRIBE_TRANSLATE_API_KEY, then GEMINI_API_KEY", () => {
    clearEnv();
    process.env.GEMINI_API_KEY = "legacy";
    assert.equal(resolveTranslateApiKey({}), "legacy");
    process.env.SCRIBE_TRANSLATE_API_KEY = "generic";
    assert.equal(resolveTranslateApiKey({}), "generic");
  });

  it("throws a message naming both env vars when no key is set", () => {
    clearEnv();
    assert.throws(
      () => resolveTranslateApiKey({ translate: { adapter: gemini() } }),
      /SCRIBE_TRANSLATE_API_KEY.*GEMINI_API_KEY/,
    );
  });
});

describe("translate model precedence", () => {
  const type = { slugStrategy: "fixed" } as ContentTypeConfig;
  const config = (translate: ScribeConfig["translate"]) => ({ translate }) as ScribeConfig;

  it("defaults to Gemini 3.8 Flash", () => {
    assert.equal(DEFAULT_GEMINI_MODEL, "gemini-3.8-flash");
    assert.equal(resolveTranslateConfig(config(undefined), type).model, undefined);
  });

  it("uses the adapter model over the deprecated defaultModel", () => {
    assert.equal(
      resolveTranslateConfig(config({ adapter: gemini({ model: "gemini-3.1-pro" }), defaultModel: "x" }), type).model,
      "gemini-3.1-pro",
    );
    assert.equal(resolveTranslateConfig(config({ defaultModel: "gemini-3.1-pro" }), type).model, "gemini-3.1-pro");
  });

  it("lets a content type override the adapter model", () => {
    const typed = { ...type, translate: { model: "gemini-3.1-pro" } } as ContentTypeConfig;
    assert.equal(resolveTranslateConfig(config({ adapter: gemini({ model: "gemini-3.8-flash" }) }), typed).model, "gemini-3.1-pro");
  });
});
