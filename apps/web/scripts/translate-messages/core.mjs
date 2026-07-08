// Core: messages/lockfile IO, stale detection, placeholder validation.
// Preserves next-intl's JSON shape exactly (2-space indent, no key sorting,
// UTF-8 no escaping, trailing newline). Anything else creates noise diffs.
//
// Adapted from FittingRoom's scripts/translate-messages (apps/landing) for
// scribe-crm's apps/web. Kept as close to upstream as possible so future syncs
// stay easy. Local changes: ALL_LOCALES/LOCALE_NAMES for this project's locales,
// and findStaleEntries also treats a value identical to the English source as
// stale when the key has no lockfile entry yet (this repo seeds untranslated
// keys with the English string rather than leaving them empty; once translated,
// an identical value is accepted). LANDING_DIR keeps its upstream name but
// resolves to apps/web here.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
// scripts/translate-messages -> scripts -> apps/web
export const LANDING_DIR = path.resolve(SCRIPT_DIR, "..", "..");
export const MESSAGES_DIR = path.join(LANDING_DIR, "messages");
export const LOCKFILES_DIR = path.join(MESSAGES_DIR, ".locks");
export const SRC_DIR = path.join(LANDING_DIR, "src");

export const DEFAULT_LOCALE = "en";

// Must match apps/web/locales.ts.
export const ALL_LOCALES = [
  "en", "fr", "pt-BR", "zh-CN", "es", "de", "ja", "ar", "it", "ru",
];

export const LOCALE_NAMES = {
  fr: "French",
  "pt-BR": "Brazilian Portuguese",
  "zh-CN": "Simplified Chinese",
  es: "Spanish",
  de: "German",
  ja: "Japanese",
  ar: "Arabic",
  it: "Italian",
  ru: "Russian",
};

export function localeName(locale) {
  return LOCALE_NAMES[locale] || locale;
}

/** ISO 8601 UTC, seconds precision, Z suffix. e.g. 2026-07-06T12:00:00Z */
export function isoNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

// --------------------------------------------------------------------------- //
// Messages IO
// --------------------------------------------------------------------------- //

export function messagesPath(locale) {
  return path.join(MESSAGES_DIR, `${locale}.json`);
}

/** Read messages/<locale>.json into { namespace: { key: value } }. */
export function loadMessages(locale) {
  const p = messagesPath(locale);
  if (!fs.existsSync(p)) return {};
  let data;
  try {
    data = JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return {};
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const out = {};
  for (const [ns, items] of Object.entries(data)) {
    if (items && typeof items === "object" && !Array.isArray(items)) {
      const inner = {};
      for (const [k, v] of Object.entries(items)) {
        if (typeof v === "string") inner[k] = v;
      }
      out[ns] = inner;
    }
  }
  return out;
}

function atomicWrite(filePath, text) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, text, "utf-8");
  fs.renameSync(tmp, filePath);
}

/** Write messages/<locale>.json: 2-space indent, no sorting, trailing newline. */
export function saveMessages(locale, data) {
  const text = JSON.stringify(data, null, 2) + "\n";
  atomicWrite(messagesPath(locale), text);
}

// --------------------------------------------------------------------------- //
// Lockfile IO — { "<ns>.<key>": { model, translated_at } }, sorted keys on save.
// --------------------------------------------------------------------------- //

export function lockfilePath(locale) {
  return path.join(LOCKFILES_DIR, `${locale}.lock.json`);
}

export function loadLockfile(locale) {
  const p = lockfilePath(locale);
  if (!fs.existsSync(p)) return {};
  let data;
  try {
    data = JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return {};
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const out = {};
  for (const [cid, entry] of Object.entries(data)) {
    if (entry && typeof entry === "object" && typeof entry.model === "string") {
      out[cid] = { model: entry.model, translated_at: String(entry.translated_at || "") };
    }
  }
  return out;
}

export function saveLockfile(locale, locks) {
  fs.mkdirSync(LOCKFILES_DIR, { recursive: true });
  const sortedKeys = Object.keys(locks).sort();
  const payload = {};
  for (const cid of sortedKeys) {
    payload[cid] = { model: locks[cid].model, translated_at: locks[cid].translated_at };
  }
  const text = JSON.stringify(payload, null, 2) + "\n";
  atomicWrite(lockfilePath(locale), text);
}

/** Count locked translations per model. */
export function modelBreakdown(locale) {
  const locks = loadLockfile(locale);
  const out = {};
  for (const e of Object.values(locks)) {
    out[e.model] = (out[e.model] || 0) + 1;
  }
  return out;
}

// --------------------------------------------------------------------------- //
// Stale detection
// --------------------------------------------------------------------------- //

/** List of { namespace, key, enValue } for non-empty en values. */
export function collectEnEntries(enData) {
  const out = [];
  for (const [ns, items] of Object.entries(enData)) {
    for (const [key, val] of Object.entries(items)) {
      if (val) out.push({ namespace: ns, key, enValue: val });
    }
  }
  return out;
}

/**
 * Return EN entries needing translation for `locale`.
 * Default: empty locale value => stale. Adapted for this repo: a value that is
 * identical to the English source is also stale, because untranslated keys here
 * are seeded with the English string rather than left empty.
 * Optional: any key whose lockfile model is in retranslateModels => stale.
 * force: EVERY EN entry is treated as stale (full re-localization).
 * Only loads the lockfile when retranslateModels is non-empty (Python parity).
 */
export function findStaleEntries(locale, enEntries, retranslateModels = [], force = false) {
  const localeData = loadMessages(locale);
  // Lockfile is always loaded here (upstream loads it only for retranslateModels):
  // the identical-to-English check below must not re-flag keys that a previous
  // run translated and legitimately kept identical (e.g. "Blog" in French).
  const locks = loadLockfile(locale);
  const retranslate = new Set(retranslateModels);

  const out = [];
  for (const entry of enEntries) {
    const cur = (localeData[entry.namespace] && localeData[entry.namespace][entry.key]) || "";
    if (force) {
      out.push({ entry, localeValue: cur });
      continue;
    }
    const locked = Boolean(locks[`${entry.namespace}.${entry.key}`]);
    if (!cur || (cur === entry.enValue && !locked)) {
      out.push({ entry, localeValue: cur });
      continue;
    }
    if (retranslate.size) {
      const lock = locks[`${entry.namespace}.${entry.key}`];
      if (lock && retranslate.has(lock.model)) {
        out.push({ entry, localeValue: cur });
      }
    }
  }
  return out;
}

// --------------------------------------------------------------------------- //
// Placeholder validation — sorted-list equality of ICU/interpolation markers.
// --------------------------------------------------------------------------- //

const PLACEHOLDER_RE = /\{[a-zA-Z_][a-zA-Z0-9_]*(?:,[^{}]*)?\}/g;

export function placeholdersIn(value) {
  return value.match(PLACEHOLDER_RE) || [];
}

export function placeholdersMatch(source, translation) {
  const src = placeholdersIn(source).sort();
  const dst = placeholdersIn(translation).sort();
  if (src.length !== dst.length) return false;
  for (let i = 0; i < src.length; i++) {
    if (src[i] !== dst[i]) return false;
  }
  return true;
}
