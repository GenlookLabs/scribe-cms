import { createScribe } from "scribe-cms/runtime";
import type { ScribeClient } from "scribe-cms/runtime";
import config from "../../scribe.config";

export type WebConfig = typeof config;
export type WebScribe = ScribeClient<WebConfig>;

let cached: WebScribe | null = null;

export function getScribe(): WebScribe {
  if (!cached) {
    cached = createScribe(config);
  }
  return cached;
}
