#!/usr/bin/env node
// Entry point for the translate-messages tool. Commands: status, translate.

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_LOCALE,
  ALL_LOCALES,
  loadMessages,
  saveMessages,
  loadLockfile,
  saveLockfile,
  modelBreakdown,
  collectEnEntries,
  findStaleEntries,
  placeholdersMatch,
  isoNow,
} from "./core.mjs";
import { buildPrompt } from "./context.mjs";
import {
  DEFAULT_MODEL,
  resolveModelId,
  estimateCost,
  formatCost,
  countTokens,
  generateContent,
  uploadJsonl,
  batchJsonlLine,
  createBatch,
  getBatch,
  batchState,
  cancelBatch,
  downloadBatchResults,
} from "./gemini.mjs";
import { printEstimateTable, LiveDashboard, MultiBatchPollUI, printSummary } from "./ui.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const LANDING_DIR = path.resolve(SCRIPT_DIR, "..", "..");
const CACHE_DIR = path.join(SCRIPT_DIR, ".cache");
const PENDING_BATCH_FILE = path.join(CACHE_DIR, "pending-batch.json");

// Output-token estimate heuristic constants.
//
// Output tokens per call = JSON body (~staleEnChars/3) + a roughly-fixed
// per-call thinking cost. Thinking has a per-call floor that dominates for
// small calls, so it is modeled as an additive constant per call rather than a
// percentage of the body.
//
// Calibrated against measured paid runs (2026-07-06):
//   - es live (10 tiny keys, 1 call):  est 73 -> actual 1,200
//   - de batch (15 calls):             est 15.4k -> actual 48.7k
//   - full batch (12 locales, 180 calls): est 184.9k -> actual 610.7k (~3.3x)
//
// The full-run body text is ~92k tokens, so batch thinking is
//   (610.7k - 92k) / 180 calls ≈ 2.9k tokens/call. Live (low thinking) has a
// smaller floor: the es call's ~1.2k with a near-zero body implies ~1k/call.
// This puts the es case at ~1.1k, de at ~49k, and the full run at ~596k — all
// within the ±30% target for an estimate.
const OUTPUT_CHARS_PER_TOKEN = 3;
const PER_CALL_THINKING_TOKENS_LIVE = 1000;
const PER_CALL_THINKING_TOKENS_BATCH = 2800;

// Tiny-namespace merge params.
const MERGE_MAX_KEYS = 30; // per merged call
const MERGE_SMALL_NS_THRESHOLD = 5; // ns with <5 stale keys are mergeable

// Auto-mode threshold.
const AUTO_BATCH_THRESHOLD = 50;

// --------------------------------------------------------------------------- //
// Env loader
// --------------------------------------------------------------------------- //

function parseEnvFile(filePath) {
  const out = {};
  let text;
  try {
    text = fs.readFileSync(filePath, "utf-8");
  } catch {
    return out;
  }
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function loadEnv() {
  if (process.env.GEMINI_API_KEY) return;
  const candidates = [
    path.join(LANDING_DIR, ".env.local"),
    path.join(LANDING_DIR, ".env"),
  ];
  for (const c of candidates) {
    const env = parseEnvFile(c);
    if (env.GEMINI_API_KEY) {
      for (const [k, v] of Object.entries(env)) {
        if (process.env[k] === undefined) process.env[k] = v;
      }
      return;
    }
  }
}

// --------------------------------------------------------------------------- //
// Interactive locale picker
// --------------------------------------------------------------------------- //

/**
 * Parse a locale-picker line. Pure + exported so it is testable without a TTY.
 *
 *   input: the raw line the user typed.
 *   available: the valid locale codes to pick from.
 *
 * Rules: empty input or "all" (case-insensitive) => every available locale.
 * Otherwise split on commas/whitespace, validate each code against `available`.
 * Returns { locales, invalid }:
 *   - locales: selected codes (in `available` order), [] when any code invalid.
 *   - invalid: codes not in `available` (empty on success).
 */
export function parsePickerInput(input, available) {
  const raw = String(input == null ? "" : input).trim();
  if (raw === "" || raw.toLowerCase() === "all") {
    return { locales: [...available], invalid: [] };
  }
  const tokens = raw
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  const availSet = new Set(available);
  const invalid = tokens.filter((t) => !availSet.has(t));
  if (invalid.length) return { locales: [], invalid };
  // De-dupe, keep `available` order for determinism.
  const chosen = new Set(tokens);
  return { locales: available.filter((l) => chosen.has(l)), invalid: [] };
}

function askLine(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * Interactive picker: print per-locale stale counts, then read a selection
 * from stdin (accepts `all`, a comma/space list, or empty = all). Re-asks once
 * on invalid input, then falls back to all. Returns the chosen locale codes.
 */
async function pickLocalesInteractive(available, enEntries) {
  console.log("Stale keys per locale:");
  for (const locale of available) {
    const stale = findStaleEntries(locale, enEntries);
    console.log(`  ${locale.padStart(5)}: ${String(stale.length).padStart(4)} stale`);
  }
  console.log("");

  const prompt = "Translate which locales? [all | comma/space list | empty=all]: ";
  let answer = await askLine(prompt);
  let { locales, invalid } = parsePickerInput(answer, available);
  if (invalid.length) {
    console.log(`Unknown locale code(s): ${invalid.join(", ")}. Try again.`);
    answer = await askLine(prompt);
    ({ locales, invalid } = parsePickerInput(answer, available));
    if (invalid.length) {
      console.log(`Still unknown: ${invalid.join(", ")}. Defaulting to all locales.`);
      locales = [...available];
    }
  }
  return locales;
}

// --------------------------------------------------------------------------- //
// status
// --------------------------------------------------------------------------- //

function cmdStatus(locales) {
  const enData = loadMessages(DEFAULT_LOCALE);
  const enEntries = collectEnEntries(enData);
  const targets = locales.length
    ? locales
    : ALL_LOCALES.filter((l) => l !== DEFAULT_LOCALE);

  console.log(
    `EN entries: ${enEntries.length} keys across ${Object.keys(enData).length} namespaces`
  );
  for (const locale of targets) {
    const stale = findStaleEntries(locale, enEntries);
    const breakdown = modelBreakdown(locale);
    const entries = Object.entries(breakdown).sort((a, b) => a[0].localeCompare(b[0]));
    const breakdownStr = entries.length
      ? "  by model: " + entries.map(([m, n]) => `${m}=${n}`).join(", ")
      : "  (no lockfile yet)";
    console.log(
      `  ${locale.padStart(5)}: ${String(stale.length).padStart(4)} empty / untranslated${breakdownStr}`
    );
  }
  return 0;
}

// --------------------------------------------------------------------------- //
// Batch unit construction (per locale): merge tiny namespaces.
// --------------------------------------------------------------------------- //

function buildBatchUnits(locale, enEntries, retranslateModels, force = false) {
  const stale = findStaleEntries(locale, enEntries, retranslateModels, force);
  if (!stale.length) return [];

  // Group stale keys by namespace, preserving first-seen order.
  const byNs = new Map(); // ns -> [key]
  for (const s of stale) {
    const ns = s.entry.namespace;
    if (!byNs.has(ns)) byNs.set(ns, []);
    byNs.get(ns).push(s.entry.key);
  }

  const units = [];
  const smallNs = []; // [{ ns, keys }]
  for (const [ns, keys] of byNs) {
    if (keys.length >= MERGE_SMALL_NS_THRESHOLD) {
      units.push({
        locale,
        namespaces: [ns],
        staleKeys: keys.map((k) => ({ ns, key: k })),
      });
    } else {
      smallNs.push({ ns, keys });
    }
  }

  // Greedily pack small namespaces up to MERGE_MAX_KEYS per merged call.
  let cur = null;
  let curCount = 0;
  for (const { ns, keys } of smallNs) {
    if (cur && curCount + keys.length > MERGE_MAX_KEYS) {
      units.push(cur);
      cur = null;
      curCount = 0;
    }
    if (!cur) {
      cur = { locale, namespaces: [], staleKeys: [] };
      curCount = 0;
    }
    cur.namespaces.push(ns);
    for (const k of keys) cur.staleKeys.push({ ns, key: k });
    curCount += keys.length;
  }
  if (cur && cur.staleKeys.length) units.push(cur);

  return units;
}

/** Response schema for a batch unit (single or merged namespaces). */
function schemaForUnit(unit) {
  const byNs = new Map();
  for (const { ns, key } of unit.staleKeys) {
    if (!byNs.has(ns)) byNs.set(ns, []);
    byNs.get(ns).push(key);
  }
  if (unit.namespaces.length === 1) {
    const ns = unit.namespaces[0];
    const keys = byNs.get(ns) || [];
    const props = {};
    for (const k of keys) props[k] = { type: "STRING" };
    return { type: "OBJECT", properties: props, required: keys };
  }
  // Merged: one level deeper.
  const props = {};
  const required = [];
  for (const ns of unit.namespaces) {
    const keys = byNs.get(ns) || [];
    const inner = {};
    for (const k of keys) inner[k] = { type: "STRING" };
    props[ns] = { type: "OBJECT", properties: inner, required: keys };
    required.push(ns);
  }
  return { type: "OBJECT", properties: props, required };
}

/** Normalize a model response into a flat { "<ns>.<key>": value } map. */
function extractTranslations(unit, parsed) {
  const out = {};
  if (!parsed || typeof parsed !== "object") return out;
  if (unit.namespaces.length === 1) {
    const ns = unit.namespaces[0];
    for (const { key } of unit.staleKeys) {
      const v = parsed[key];
      if (typeof v === "string" && v.trim()) out[`${ns}.${key}`] = v.trim();
    }
  } else {
    for (const { ns, key } of unit.staleKeys) {
      const inner = parsed[ns];
      const v = inner && typeof inner === "object" ? inner[key] : undefined;
      if (typeof v === "string" && v.trim()) out[`${ns}.${key}`] = v.trim();
    }
  }
  return out;
}

function staleEnChars(unit, enData) {
  let n = 0;
  for (const { ns, key } of unit.staleKeys) {
    n += ((enData[ns] && enData[ns][key]) || "").length;
  }
  return n;
}

// Estimate output tokens for one unit (== one API call): JSON body plus a
// fixed per-call thinking floor. See the constants block above for calibration.
function estOutputTokens(unit, enData, batch) {
  const chars = staleEnChars(unit, enData);
  const body = chars / OUTPUT_CHARS_PER_TOKEN;
  const thinking = batch ? PER_CALL_THINKING_TOKENS_BATCH : PER_CALL_THINKING_TOKENS_LIVE;
  return Math.round(body + thinking);
}

// --------------------------------------------------------------------------- //
// Concurrency pool
// --------------------------------------------------------------------------- //

async function runPool(items, concurrency, worker) {
  let idx = 0;
  const runners = [];
  const n = Math.min(concurrency, items.length);
  for (let i = 0; i < n; i++) {
    runners.push(
      (async () => {
        while (idx < items.length) {
          const myIdx = idx++;
          await worker(items[myIdx], myIdx);
        }
      })()
    );
  }
  await Promise.all(runners);
}

// Order units namespace-major (all locales of same namespace-set consecutive)
// to maximize implicit prompt-cache hits.
function orderNamespaceMajor(units) {
  const keyed = units.map((u) => ({ u, key: u.namespaces.join("|") }));
  keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return keyed.map((k) => k.u);
}

// --------------------------------------------------------------------------- //
// Apply + persist a unit's translations (sync writes).
// --------------------------------------------------------------------------- //

function applyUnit(unit, translations, model, enData, localeData, locks, stats) {
  const locale = unit.locale;
  for (const { ns, key } of unit.staleKeys) {
    const tr = translations[`${ns}.${key}`];
    if (!tr) {
      stats.errors.push(`missing translation for ${ns}.${key}`);
      stats.rejected++;
      continue;
    }
    const enVal = (enData[ns] && enData[ns][key]) || "";
    if (!placeholdersMatch(enVal, tr)) {
      stats.errors.push(`placeholder drift on ${ns}.${key} — translation rejected`);
      stats.rejected++;
      continue;
    }
    if (!localeData[ns]) localeData[ns] = {};
    localeData[ns][key] = tr;
    locks[`${ns}.${key}`] = { model, translated_at: isoNow() };
    stats.translated++;
  }
  saveMessages(locale, localeData);
  saveLockfile(locale, locks);
}

// --------------------------------------------------------------------------- //
// translate
// --------------------------------------------------------------------------- //

async function cmdTranslate(opts) {
  const {
    locales,
    hadExplicitLocale,
    model,
    dryRun,
    retranslateModels,
    force,
    mode,
    concurrency,
    thinking,
    pollTimeout,
    abandonBatch,
    dumpPrompts,
  } = opts;

  const enData = loadMessages(DEFAULT_LOCALE);
  const enEntries = collectEnEntries(enData);
  const nonEnLocales = ALL_LOCALES.filter((l) => l !== DEFAULT_LOCALE);
  const isInteractive = process.stdin.isTTY && process.stdout.isTTY;

  // --force re-localizes EVERY key of the selected locales (full re-pay). Guard
  // against accidentally re-paying for all 15 locales: it requires an explicit
  // --locale selection, or an interactive confirmation.
  if (force && !hadExplicitLocale && !dryRun) {
    if (!isInteractive) {
      console.error(
        "error: --force with no --locale would re-localize every key of all locales. " +
          "Pass explicit --locale flags (e.g. --force --locale fr) or run interactively to confirm."
      );
      return 2;
    }
    const answer = await askLine(
      "--force with no --locale will re-localize EVERY key of the locales you pick (full re-pay). Continue? [y/N]: "
    );
    if (!/^y(es)?$/i.test(String(answer).trim())) {
      console.log("Aborted.");
      return 0;
    }
  }

  // Locale selection. With explicit --locale flags, honor them. With none, an
  // interactive TTY gets the picker; a non-TTY (CI/pipe) keeps all locales.
  let targets;
  if (locales.length) {
    targets = locales;
  } else if (isInteractive) {
    targets = await pickLocalesInteractive(nonEnLocales, enEntries);
    if (!targets.length) {
      console.log("No locales selected. Nothing to do.");
      return 0;
    }
  } else {
    targets = nonEnLocales;
  }

  // A pending batch state takes precedence: resume polling the still-pending
  // jobs instead of resubmitting (unless --abandon-batch cancels them first).
  // The state file may be v1 (single job across all locales) or v2 (one job
  // per locale); normalizePendingState collapses both into a per-locale map.
  const pending = normalizePendingState(loadPendingBatch());
  if (pending) {
    const jobLocales = Object.keys(pending.jobs);
    if (abandonBatch) {
      console.log(
        `Abandoning ${jobLocales.length} pending batch job(s) (--abandon-batch).`
      );
      const names = new Set(Object.values(pending.jobs).map((j) => j.name));
      for (const name of names) {
        try {
          await cancelBatch(name);
          console.log(`  cancelled ${name}`);
        } catch (err) {
          console.log(`  (cancel failed for ${name}: ${err.message || err})`);
        }
      }
      deletePendingBatch();
    } else if (dryRun) {
      console.log(
        `note: pending batch job(s) exist for ${jobLocales.join(", ")}; a non-dry-run invocation will resume polling them.`
      );
    } else {
      console.log(
        `Pending batch job(s) found for ${jobLocales.join(", ")}; resuming polling. Use --abandon-batch to cancel them instead.`
      );
      return resumePendingBatch(pending, {
        model: pending.model || model,
        pollTimeout,
        enData,
      });
    }
  }

  // Build all batch units and their prompts.
  const localeData = new Map(); // locale -> loaded messages
  const allUnits = [];
  for (const locale of targets) {
    localeData.set(locale, loadMessages(locale));
    const units = buildBatchUnits(locale, enEntries, retranslateModels, force);
    for (const u of units) allUnits.push(u);
  }

  if (!allUnits.length) {
    console.log("Nothing stale. All target locales are up to date.");
    return 0;
  }

  // Build prompts for every unit.
  for (const u of allUnits) {
    u.prompt = buildPrompt(u, enData, localeData.get(u.locale));
    u.schema = schemaForUnit(u);
  }

  // --dump-prompts: write every prompt with a header.
  if (dumpPrompts) {
    const chunks = [];
    for (const u of allUnits) {
      chunks.push(`==== ${u.locale}/${u.namespaces.join(",")}`);
      chunks.push(u.prompt);
      chunks.push("");
    }
    fs.writeFileSync(dumpPrompts, chunks.join("\n"), "utf-8");
    console.log(`Wrote ${allUnits.length} prompt(s) to ${dumpPrompts}`);
  }

  // Determine mode (needed for estimate discount + output allowance).
  const totalStale = allUnits.reduce((n, u) => n + u.staleKeys.length, 0);
  let chosenMode = mode;
  if (mode === "auto") chosenMode = totalStale < AUTO_BATCH_THRESHOLD ? "live" : "batch";
  const isBatchMode = chosenMode === "batch";

  // Pre-flight: countTokens for all prompts (concurrency 8).
  console.log(`Counting tokens for ${allUnits.length} prompt(s)...`);
  const modelId = resolveModelId(model);
  await runPool(allUnits, 8, async (u) => {
    try {
      u.inputTokens = await countTokens(modelId, u.prompt);
    } catch (err) {
      u.inputTokens = 0;
      u.tokenErr = String(err.message || err);
    }
  });

  // Surface countTokens failures — a table of zeros with no explanation would
  // mask a bad API key or network issue.
  const tokenErrs = allUnits.filter((u) => u.tokenErr);
  for (const u of tokenErrs.slice(0, 5)) {
    console.error(`warn: countTokens failed for ${u.locale}/${u.namespaces.join(",")}: ${u.tokenErr}`);
  }
  if (tokenErrs.length > 5) console.error(`warn: … and ${tokenErrs.length - 5} more`);
  if (tokenErrs.length === allUnits.length) {
    console.error("error: every countTokens call failed — check GEMINI_API_KEY and network.");
    return 1;
  }

  // Build the estimate table (per locale).
  const perLocale = new Map();
  for (const u of allUnits) {
    if (!perLocale.has(u.locale)) {
      perLocale.set(u.locale, {
        locale: u.locale,
        batches: 0,
        staleKeys: 0,
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
        costKnown: false,
      });
    }
    const r = perLocale.get(u.locale);
    r.batches++;
    r.staleKeys += u.staleKeys.length;
    r.inputTokens += u.inputTokens;
    const outTok = estOutputTokens(u, enData, isBatchMode);
    r.outputTokens += outTok;
    const c = estimateCost(model, u.inputTokens, outTok, { batch: isBatchMode });
    if (c !== null) {
      r.cost += c;
      r.costKnown = true;
    }
  }
  const rows = [...perLocale.values()].map((r) => ({
    locale: r.locale,
    batches: r.batches,
    staleKeys: r.staleKeys,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cost: r.costKnown ? r.cost : null,
  }));

  // Recompute a live-equivalent estimate for the mode line.
  let liveEst = 0;
  for (const u of allUnits) {
    const outTok = estOutputTokens(u, enData, false);
    const c = estimateCost(model, u.inputTokens, outTok, { batch: false });
    if (c !== null) liveEst += c;
  }
  const chosenEst = rows.reduce((n, r) => n + (r.cost || 0), 0);

  let modeLine;
  if (mode === "auto") {
    if (isBatchMode) {
      modeLine = `mode: batch (50% off) — estimated ${formatCost(chosenEst)} (live would be ~${formatCost(liveEst)})  [auto: ${totalStale} stale >= ${AUTO_BATCH_THRESHOLD}]`;
    } else {
      modeLine = `mode: live — estimated ${formatCost(chosenEst)}  [auto: ${totalStale} stale < ${AUTO_BATCH_THRESHOLD}]`;
    }
  } else if (isBatchMode) {
    modeLine = `mode: batch (50% off) — estimated ${formatCost(chosenEst)} (live would be ~${formatCost(liveEst)})`;
  } else {
    modeLine = `mode: live — estimated ${formatCost(chosenEst)}`;
  }

  printEstimateTable(rows, modeLine);

  if (dryRun) {
    console.log("");
    console.log("--dry-run: no paid calls made.");
    return 0;
  }

  // Group loaded lockfiles per locale (loaded once, mutated as we go).
  const localeLocks = new Map();
  for (const locale of targets) localeLocks.set(locale, loadLockfile(locale));

  // Per-locale running stats.
  const localeStats = new Map();
  for (const locale of targets) {
    localeStats.set(locale, {
      locale,
      translated: 0,
      rejected: 0,
      tokensIn: 0,
      tokensOut: 0,
      cost: 0,
      errors: [],
    });
  }

  const allErrors = [];
  let hadError = false;

  if (isBatchMode) {
    hadError = await runBatchMode({
      allUnits,
      model,
      modelId,
      pollTimeout,
      enData,
      localeData,
      localeLocks,
      localeStats,
      allErrors,
    });
  } else {
    hadError = await runLiveMode({
      allUnits,
      model,
      modelId,
      thinking,
      concurrency,
      chosenEst,
      enData,
      localeData,
      localeLocks,
      localeStats,
      allErrors,
    });
  }

  printSummary([...localeStats.values()], allErrors);
  return hadError ? 1 : 0;
}

// --------------------------------------------------------------------------- //
// Live mode
// --------------------------------------------------------------------------- //

async function runLiveMode(ctx) {
  const {
    allUnits,
    model,
    modelId,
    thinking,
    concurrency,
    chosenEst,
    enData,
    localeData,
    localeLocks,
    localeStats,
    allErrors,
  } = ctx;

  const ordered = orderNamespaceMajor(allUnits);
  const dash = new LiveDashboard({ totalBatches: ordered.length, estCost: chosenEst });
  for (const u of ordered) dash.registerLocale(u.locale, 1);
  dash.render();

  let hadError = false;

  await runPool(ordered, concurrency, async (u) => {
    const stats = localeStats.get(u.locale);
    try {
      const { parsed, usage } = await generateContent(modelId, u.prompt, u.schema, thinking);
      const tokensIn = usage.promptTokenCount;
      const tokensOut = usage.candidatesTokenCount + usage.thoughtsTokenCount;
      const cost = estimateCost(model, tokensIn, tokensOut, { batch: false });
      stats.tokensIn += tokensIn;
      stats.tokensOut += tokensOut;
      if (cost !== null) stats.cost += cost;

      const translations = extractTranslations(u, parsed);
      applyUnit(u, translations, model, enData, localeData.get(u.locale), localeLocks.get(u.locale), stats);
      for (const e of stats.errors.splice(0)) {
        allErrors.push(`${u.locale}: ${e}`);
        hadError = true;
      }
      dash.onBatchDone(u.locale, { tokensIn, tokensOut, cost });
      dash.logPlainBatch(u.locale, u.namespaces.join(","), { tokensIn, tokensOut, cost });
    } catch (err) {
      const msg = `${u.locale}/${u.namespaces.join(",")}: ${err.message || err}`;
      allErrors.push(msg);
      dash.onError(msg);
      hadError = true;
    }
  });

  return hadError;
}

// --------------------------------------------------------------------------- //
// Batch mode
// --------------------------------------------------------------------------- //

function loadPendingBatch() {
  try {
    return JSON.parse(fs.readFileSync(PENDING_BATCH_FILE, "utf-8"));
  } catch {
    return null;
  }
}
function savePendingBatch(state) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(PENDING_BATCH_FILE, JSON.stringify(state, null, 2) + "\n", "utf-8");
}
function deletePendingBatch() {
  try {
    fs.unlinkSync(PENDING_BATCH_FILE);
  } catch {
    /* ignore */
  }
}

/**
 * Normalize a raw pending-state object into the v2 shape:
 *   { version: 2, model, createdAt, jobs: { <locale>: { name, keys } } }
 *
 * Accepts:
 *  - v2: `{ version: 2, ..., jobs }` — returned as-is (jobs validated).
 *  - v1: `{ name, model, createdAt, keys }` — a single job whose `keys` span
 *    multiple locales. We fan those keys out by locale, all pointing at the
 *    same job `name`, so a legacy single-job run resumes correctly.
 * Returns null if there is nothing pollable.
 */
function normalizePendingState(raw) {
  if (!raw || typeof raw !== "object") return null;

  // v2 already.
  if (raw.version === 2 && raw.jobs && typeof raw.jobs === "object") {
    const jobs = {};
    for (const [locale, job] of Object.entries(raw.jobs)) {
      if (job && typeof job === "object" && typeof job.name === "string" && job.keys) {
        jobs[locale] = { name: job.name, keys: job.keys };
      }
    }
    if (!Object.keys(jobs).length) return null;
    return { version: 2, model: raw.model, createdAt: raw.createdAt, jobs };
  }

  // v1: single job, keys across all locales.
  if (typeof raw.name === "string" && raw.keys && typeof raw.keys === "object") {
    const jobs = {};
    for (const [batchKey, desc] of Object.entries(raw.keys)) {
      if (!desc || !desc.locale) continue;
      const locale = desc.locale;
      if (!jobs[locale]) jobs[locale] = { name: raw.name, keys: {} };
      jobs[locale].keys[batchKey] = desc;
    }
    if (!Object.keys(jobs).length) return null;
    return { version: 2, model: raw.model, createdAt: raw.createdAt, jobs };
  }

  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Stable per-unit batch key: `<locale>/<ns1+ns2>` (namespaces are disjoint
 * across a locale's units, so this is unique within a job — and it survives
 * a resume, unlike positional indexes). */
function batchKeyFor(unit) {
  return `${unit.locale}/${unit.namespaces.join("+")}`;
}

// Normalize a raw batch state string into a bare phase (SUCCEEDED/RUNNING/...).
// The docs name states JOB_STATE_*, but the live API returns BATCH_STATE_*.
function phaseOf(state) {
  return String(state || "").replace(/^(JOB|BATCH)_STATE_/, "");
}

/**
 * Submit one batch job per locale (all concurrently) and poll them jointly,
 * applying each locale's results as soon as its job succeeds.
 */
async function runBatchMode(ctx) {
  const { allUnits, model, modelId, pollTimeout, enData, localeData, localeLocks, localeStats, allErrors } = ctx;

  // Group units by locale; each locale becomes its own JSONL + batch job.
  const unitsByLocale = new Map();
  for (const u of allUnits) {
    u._batchKey = batchKeyFor(u);
    if (!unitsByLocale.has(u.locale)) unitsByLocale.set(u.locale, []);
    unitsByLocale.get(u.locale).push(u);
  }
  const locales = [...unitsByLocale.keys()];

  console.log(`Submitting ${locales.length} batch job(s) (one per locale)...`);

  // Upload + create every locale's job concurrently. Persisted state is built
  // incrementally so a crash mid-submission still leaves resumable jobs.
  const pendingState = { version: 2, model, createdAt: isoNow(), jobs: {} };
  const jobByLocale = new Map(); // locale -> { name, unitByKey, keys }

  await Promise.all(
    locales.map(async (locale) => {
      const units = unitsByLocale.get(locale);
      const keyMap = {};
      const lines = [];
      for (const u of units) {
        keyMap[u._batchKey] = {
          locale: u.locale,
          namespaces: u.namespaces,
          staleKeys: u.staleKeys,
        };
        lines.push(batchJsonlLine(u._batchKey, u.prompt, u.schema));
      }
      try {
        const fileName = await uploadJsonl(lines);
        const batchName = await createBatch(modelId, fileName);
        const unitByKey = new Map(units.map((u) => [u._batchKey, u]));
        jobByLocale.set(locale, { name: batchName, unitByKey, keys: keyMap });
        pendingState.jobs[locale] = { name: batchName, keys: keyMap };
        savePendingBatch(pendingState);
        console.log(`  ${locale}: ${batchName}`);
      } catch (err) {
        allErrors.push(`${locale}: batch submit failed: ${err.message || err}`);
      }
    })
  );

  if (!jobByLocale.size) {
    console.error("error: no batch jobs were submitted successfully.");
    return true;
  }

  return pollAndApplyJobs({
    jobByLocale,
    model,
    pollTimeout,
    enData,
    localeData,
    localeLocks,
    localeStats,
    allErrors,
  });
}

/**
 * Resume polling previously submitted batch jobs. Units are reconstructed from
 * the persisted (normalized-to-v2) state — NOT from a fresh stale scan, since
 * the stale set may have changed since submission — so results always map to
 * the keys that were actually sent.
 */
async function resumePendingBatch(pending, { model, pollTimeout, enData }) {
  const jobByLocale = new Map();
  for (const [locale, job] of Object.entries(pending.jobs)) {
    const unitByKey = new Map();
    for (const [batchKey, desc] of Object.entries(job.keys || {})) {
      if (!desc || !desc.locale || !Array.isArray(desc.staleKeys)) continue;
      unitByKey.set(batchKey, {
        locale: desc.locale,
        namespaces: desc.namespaces || [],
        staleKeys: desc.staleKeys,
        _batchKey: batchKey,
      });
    }
    if (unitByKey.size) {
      jobByLocale.set(locale, { name: job.name, unitByKey, keys: job.keys });
    }
  }
  if (!jobByLocale.size) {
    console.error("error: pending-batch state file is empty/corrupt; delete it or use --abandon-batch.");
    return 1;
  }

  const localeData = new Map();
  const localeLocks = new Map();
  const localeStats = new Map();
  for (const locale of jobByLocale.keys()) {
    localeData.set(locale, loadMessages(locale));
    localeLocks.set(locale, loadLockfile(locale));
    localeStats.set(locale, {
      locale,
      translated: 0,
      rejected: 0,
      tokensIn: 0,
      tokensOut: 0,
      cost: 0,
      errors: [],
    });
  }

  const allErrors = [];
  const hadError = await pollAndApplyJobs({
    jobByLocale,
    model,
    pollTimeout,
    enData,
    localeData,
    localeLocks,
    localeStats,
    allErrors,
  });
  printSummary([...localeStats.values()], allErrors);
  return hadError ? 1 : 0;
}

/**
 * Joint poll loop over all locale jobs. Each tick queries every still-pending
 * job (sequentially within the tick), applies any that succeeded, and records
 * an error for any that failed/expired/cancelled — without blocking the rest.
 * The overall 30s interval and the --poll-timeout deadline apply to the loop.
 */
async function pollAndApplyJobs(ctx) {
  const { jobByLocale, model, pollTimeout, enData, localeData, localeLocks, localeStats, allErrors } = ctx;

  const ui = new MultiBatchPollUI([...jobByLocale.keys()]);
  // Per-locale poll status. `done` locales are no longer queried.
  const status = new Map();
  for (const locale of jobByLocale.keys()) {
    status.set(locale, { done: false, applied: false });
  }
  ui.render();

  const deadline = Date.now() + pollTimeout * 60 * 1000;
  let hadError = false;

  const remaining = () => [...status.entries()].filter(([, s]) => !s.done).map(([l]) => l);

  while (remaining().length) {
    for (const locale of remaining()) {
      const job = jobByLocale.get(locale);
      let json;
      try {
        json = await getBatch(job.name);
      } catch (err) {
        ui.set(locale, "PENDING", `(poll error: ${String(err.message || err).slice(0, 40)})`);
        ui.render();
        continue;
      }
      const phase = phaseOf(batchState(json));

      if (phase === "SUCCEEDED") {
        ui.set(locale, "SUCCEEDED", "→ applying...");
        ui.render();
        const localeHadError = await applyJobResults({
          locale,
          json,
          unitByKey: job.unitByKey,
          model,
          enData,
          localeData,
          localeLocks,
          localeStats,
          allErrors,
        });
        if (localeHadError) hadError = true;
        // Remove this locale's job from the persisted state.
        removeLocaleFromPending(locale);
        status.get(locale).done = true;
        status.get(locale).applied = true;
        ui.set(locale, "APPLIED", localeHadError ? "(with errors)" : "");
        ui.render();
        continue;
      }

      if (phase === "FAILED" || phase === "CANCELLED" || phase === "EXPIRED") {
        allErrors.push(`${locale}: batch ${job.name} terminated in state ${phase}`);
        hadError = true;
        removeLocaleFromPending(locale);
        status.get(locale).done = true;
        ui.set(locale, phase, "");
        ui.render();
        continue;
      }

      // Still in flight. Map RUNNING/PENDING/QUEUED etc. onto a display phase.
      ui.set(locale, phase === "RUNNING" ? "RUNNING" : "PENDING", "");
    }

    ui.render();

    if (!remaining().length) break;

    if (Date.now() > deadline) {
      const still = remaining();
      console.log("");
      console.log(
        `Poll timeout reached. Still pending: ${still.join(", ")}. Rerun the same command to resume polling them.`
      );
      return hadError; // resumable; not itself a failure
    }
    await sleep(30_000);
  }

  // All jobs terminal — nothing left to resume.
  deletePendingBatch();
  return hadError;
}

/** Download one locale's batch results and apply them. Returns hadError. */
async function applyJobResults(ctx) {
  const { locale, json, unitByKey, model, enData, localeData, localeLocks, localeStats, allErrors } = ctx;

  let results;
  try {
    results = await downloadBatchResults(json);
  } catch (err) {
    allErrors.push(`${locale}: batch download failed: ${err.message || err}`);
    return true;
  }

  let hadError = false;
  for (const line of results) {
    const u = unitByKey.get(line.key);
    if (!u) continue;
    const stats = localeStats.get(u.locale);

    // Branch on shape: response vs error/status.
    const resp = line.response || line.value?.response || line.value;
    const errObj = line.error || line.status || line.value?.error;
    if (errObj && !resp?.candidates) {
      const msg = `${u.locale}/${u.namespaces.join(",")}: batch error ${JSON.stringify(errObj).slice(0, 200)}`;
      allErrors.push(msg);
      hadError = true;
      continue;
    }

    // Parse the GenerateContentResponse.
    const parsed = parseBatchResponseText(resp);
    const usage = resp?.usageMetadata || {};
    const tokensIn = Number(usage.promptTokenCount || 0);
    const tokensOut = Number(usage.candidatesTokenCount || 0) + Number(usage.thoughtsTokenCount || 0);
    const cost = estimateCost(model, tokensIn, tokensOut, { batch: true });
    stats.tokensIn += tokensIn;
    stats.tokensOut += tokensOut;
    if (cost !== null) stats.cost += cost;

    const translations = extractTranslations(u, parsed);
    applyUnit(u, translations, model, enData, localeData.get(u.locale), localeLocks.get(u.locale), stats);
    for (const e of stats.errors.splice(0)) {
      allErrors.push(`${u.locale}: ${e}`);
      hadError = true;
    }
  }

  return hadError;
}

/**
 * Remove one locale's job from the persisted pending-batch state file (v2). If
 * the file on disk is still v1, normalize it to v2 first so removal is safe.
 * When no jobs remain the file is deleted.
 */
function removeLocaleFromPending(locale) {
  const state = normalizePendingState(loadPendingBatch());
  if (!state) return;
  delete state.jobs[locale];
  if (!Object.keys(state.jobs).length) {
    deletePendingBatch();
  } else {
    savePendingBatch(state);
  }
}

function parseBatchResponseText(resp) {
  const cand = resp?.candidates?.[0];
  const parts = cand?.content?.parts || [];
  const text = parts.map((p) => p.text || "").join("");
  try {
    return JSON.parse(text || "{}");
  } catch {
    return {};
  }
}

// --------------------------------------------------------------------------- //
// Arg parsing + main
// --------------------------------------------------------------------------- //

function usage() {
  console.error(
    `Usage:
  cli.mjs status [--locale <l> ...]
  cli.mjs translate [--locale <l> ...] [--model <name>] [--dry-run] [--force]
                    [--retranslate-models <m> ...] [--mode auto|live|batch]
                    [--concurrency N] [--thinking low|medium|high]
                    [--poll-timeout <minutes>] [--abandon-batch]
                    [--dump-prompts <file>]`
  );
}

async function main() {
  loadEnv();

  // pnpm forwards a literal `--` separator into argv (`pnpm i18n:translate --
  // --dry-run`); strip it so both `pnpm run` styles and direct node work.
  const argv = process.argv.slice(2).filter((a) => a !== "--");
  const command = argv[0];

  if (command !== "status" && command !== "translate") {
    usage();
    return 2;
  }

  let parsed;
  try {
    parsed = parseArgs({
      args: argv.slice(1),
      allowPositionals: false,
      options: {
        locale: { type: "string", multiple: true },
        model: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        force: { type: "boolean", default: false },
        "retranslate-models": { type: "string", multiple: true },
        mode: { type: "string", default: "auto" },
        concurrency: { type: "string", default: "8" },
        thinking: { type: "string", default: "low" },
        "poll-timeout": { type: "string", default: "120" },
        "abandon-batch": { type: "boolean", default: false },
        "dump-prompts": { type: "string" },
      },
    });
  } catch (err) {
    console.error(`error: ${err.message}`);
    usage();
    return 2;
  }

  const v = parsed.values;
  const locales = v.locale || [];

  if (command === "status") {
    return cmdStatus(locales);
  }

  const mode = v.mode;
  if (!["auto", "live", "batch"].includes(mode)) {
    console.error(`error: --mode must be auto|live|batch (got "${mode}")`);
    return 2;
  }
  const thinking = v.thinking;
  if (!["low", "medium", "high"].includes(thinking)) {
    console.error(`error: --thinking must be low|medium|high (got "${thinking}")`);
    return 2;
  }
  const concurrency = parseInt(v.concurrency, 10);
  if (!Number.isFinite(concurrency) || concurrency < 1) {
    console.error(`error: --concurrency must be a positive integer`);
    return 2;
  }
  const pollTimeout = parseFloat(v["poll-timeout"]);
  if (!Number.isFinite(pollTimeout) || pollTimeout <= 0) {
    console.error(`error: --poll-timeout must be a positive number of minutes`);
    return 2;
  }

  return cmdTranslate({
    locales,
    hadExplicitLocale: (v.locale || []).length > 0,
    model: v.model || DEFAULT_MODEL,
    dryRun: v["dry-run"],
    force: v.force,
    retranslateModels: v["retranslate-models"] || [],
    mode,
    concurrency,
    thinking,
    pollTimeout,
    abandonBatch: v["abandon-batch"],
    dumpPrompts: v["dump-prompts"] || null,
  });
}

// Only run the CLI when invoked directly (node cli.mjs ...), so the module can
// be imported by tests without triggering a run.
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((code) => process.exit(code || 0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

// Test-only exports (pure helpers; no side effects on import).
export { normalizePendingState, phaseOf, buildBatchUnits };
