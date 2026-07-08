// Context builder: per-namespace source dossier, voice samples, glossary,
// and the Gemini prompt template. Cache-first prompt ordering.
//
// Adapted from FittingRoom's scripts/translate-messages (apps/landing) for
// scribe-crm's apps/web. Local changes are confined to buildPrompt: the product
// context strings describe Scribe CMS instead of Genlook, and a hard rule bans
// em dashes in output. Everything else is kept identical to upstream.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { LANDING_DIR, SRC_DIR, localeName } from "./core.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(SCRIPT_DIR, ".cache");
const CACHE_FILE = path.join(CACHE_DIR, "context.json");
const GLOSSARY_FILE = path.join(SCRIPT_DIR, "glossary.json");

// Dossier caps.
const MAX_FILES_PER_NS = 6;
const MAX_DOSSIER_CHARS = 7000;
const MAX_EXCERPT_LINES = 25;
const MAX_EXCERPT_CHARS = 1200;

// Voice sample caps.
const VOICE_MAX_SAMPLES = 12;
const VOICE_SKIP_IF_NONEMPTY_GE = 15;

function ensureCacheDir() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const gi = path.join(CACHE_DIR, ".gitignore");
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, "*\n", "utf-8");
}

// --------------------------------------------------------------------------- //
// File discovery: rg when a real binary exists on PATH, otherwise git grep
// (git is guaranteed present; apps/landing lives inside the monorepo repo).
// --------------------------------------------------------------------------- //

function needlesFor(ns) {
  return [
    `getExtracted("${ns}")`,
    `getExtracted('${ns}')`,
    `useTranslations("${ns}")`,
    `useTranslations('${ns}')`,
    `getTranslations("${ns}")`,
    `getTranslations('${ns}')`,
  ];
}

let rgAvailable = null; // null = unknown, probed on first use

function grepFilesFor(needle) {
  if (rgAvailable !== false) {
    const res = spawnSync("rg", ["-F", "--files-with-matches", needle, SRC_DIR], {
      encoding: "utf-8",
      cwd: LANDING_DIR,
    });
    if (res.error && res.error.code === "ENOENT") {
      rgAvailable = false; // fall through to git grep
    } else if (res.error) {
      return [];
    } else {
      rgAvailable = true;
      // rg exits 1 on no-match; 0 on match. Anything else: skip.
      if (res.status !== 0 && res.status !== 1) return [];
      return (res.stdout || "")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((p) => path.resolve(LANDING_DIR, p));
    }
  }
  // git grep fallback. --untracked also covers files not yet committed.
  const res = spawnSync(
    "git",
    ["grep", "-F", "-l", "--untracked", needle, "--", "src"],
    { encoding: "utf-8", cwd: LANDING_DIR }
  );
  if (res.error) {
    throw new Error(
      `cannot scan source files: rg is not on PATH and git grep failed (${res.error.message})`
    );
  }
  // git grep exits 1 on no-match; 0 on match.
  if (res.status !== 0 && res.status !== 1) return [];
  return (res.stdout || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((p) => path.resolve(LANDING_DIR, p));
}

export function findNamespaceUsers(ns) {
  if (!fs.existsSync(SRC_DIR)) return [];
  const found = new Set();
  for (const needle of needlesFor(ns)) {
    for (const f of grepFilesFor(needle)) found.add(f);
  }
  return [...found].sort();
}

// --------------------------------------------------------------------------- //
// Route derivation
// --------------------------------------------------------------------------- //

export function deriveRoute(absFile) {
  let rel;
  try {
    rel = path.relative(LANDING_DIR, absFile);
  } catch {
    rel = absFile;
  }
  const appPrefix = path.join("src", "app") + path.sep;
  if (!rel.startsWith(appPrefix)) return "component";
  // Only page/layout files map to a route.
  const base = path.basename(rel);
  const isPage = base === "page.tsx" || base === "page.ts" || base === "page.jsx" || base === "page.js";
  if (!isPage) return "component";
  let sub = rel.slice(appPrefix.length);
  // drop the filename
  sub = path.dirname(sub);
  if (sub === ".") return "page /";
  const segments = sub.split(path.sep).filter((seg) => {
    if (!seg) return false;
    if (seg === "[locale]") return false;
    if (seg.startsWith("(") && seg.endsWith(")")) return false; // route group
    return true;
  });
  const route = "/" + segments.join("/");
  return `page ${route === "/" ? "/" : route}`;
}

// --------------------------------------------------------------------------- //
// Call-site classification (cheap ±3-line heuristics).
// --------------------------------------------------------------------------- //

function classifyCallSite(lines, lineIdx) {
  const lo = Math.max(0, lineIdx - 3);
  const hi = Math.min(lines.length, lineIdx + 4);
  const window = lines.slice(lo, hi).join("\n");
  const w = window;

  // Order matters: most specific first.
  const hMatch = w.match(/<h([1-6])[\s>]/);
  if (hMatch) return `h${hMatch[1]} heading`;
  if (/\btitle\s*=/.test(w) || /\bheading\b/.test(w)) return "title prop";
  if (/\bdescription\s*=/.test(w)) return "description prop";
  if (/\bplaceholder\s*=/.test(w)) return "input placeholder";
  if (/\baria-label\s*=/.test(w)) return "aria-label";
  if (/\balt\s*=/.test(w)) return "image alt text";
  if (/\blabel\s*=/.test(w)) return "label prop";
  if (/<Button|<a[\s>]|<Link[\s>]/.test(w)) return "button/CTA label";
  if (/toast|throw|error/i.test(w)) return "toast/error message";
  if (/<p[\s>]/.test(w)) return "paragraph text";
  if (/<li[\s>]/.test(w)) return "list item";
  if (/<span[\s>]/.test(w)) return "inline text";
  return "t() call";
}

// --------------------------------------------------------------------------- //
// Per-file dossier
// --------------------------------------------------------------------------- //

const BINDING_RE =
  /\b(?:const|let|var)\s+(\w+)\s*=\s*(?:await\s+)?(?:getExtracted|useTranslations|getTranslations)\s*\(/;

// Extract the first string-literal argument of `<var>(`. Returns null if the
// argument is not a plain string literal.
function extractKeyArg(afterOpenParen) {
  const s = afterOpenParen.replace(/^\s+/, "");
  const q = s[0];
  if (q !== '"' && q !== "'" && q !== "`") return null;
  let out = "";
  for (let i = 1; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") {
      out += s[i + 1] || "";
      i++;
      continue;
    }
    if (c === q) return out;
    out += c;
  }
  return null;
}

/** Build a dossier for one file. Returns { rel, route, callSites, excerpt } or null. */
function fileDossier(absFile) {
  let text;
  try {
    text = fs.readFileSync(absFile, "utf-8");
  } catch {
    return null;
  }
  const lines = text.split("\n");
  const rel = path.relative(LANDING_DIR, absFile);
  const route = deriveRoute(absFile);

  // Find binding variables + their declaration lines.
  const bindings = []; // { line, varName }
  for (let i = 0; i < lines.length; i++) {
    const m = BINDING_RE.exec(lines[i]);
    if (m) bindings.push({ line: i, varName: m[1] });
  }
  if (!bindings.length) return null;

  const varNames = [...new Set(bindings.map((b) => b.varName))];

  // Collect call sites in source order across all bound vars.
  const callSites = []; // { line, key, classification }
  for (let i = 0; i < lines.length; i++) {
    for (const v of varNames) {
      const callRe = new RegExp(`\\b${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\(`, "g");
      let m;
      while ((m = callRe.exec(lines[i])) !== null) {
        const after = lines[i].slice(m.index + m[0].length);
        const key = extractKeyArg(after);
        if (key === null) continue;
        callSites.push({ line: i, key, classification: classifyCallSite(lines, i) });
      }
    }
  }
  if (!callSites.length) return null;

  // Densest excerpt window around the binding with most nearby call sites.
  const excerpt = buildExcerpt(lines, bindings, callSites);

  return { rel, route, callSites, excerpt, callCount: callSites.length };
}

function buildExcerpt(lines, bindings, callSites) {
  // Pick the binding whose surrounding ±12 lines contain the most call sites.
  let best = bindings[0];
  let bestScore = -1;
  for (const b of bindings) {
    const near = callSites.filter((c) => Math.abs(c.line - b.line) <= 12).length;
    if (near > bestScore) {
      bestScore = near;
      best = b;
    }
  }
  // Window: from the binding line, extend to include nearby call sites (max lines).
  const start = best.line;
  const end = Math.min(lines.length, start + MAX_EXCERPT_LINES);
  const raw = lines.slice(start, end);
  // Strip leading whitespace-only and import lines.
  const filtered = raw.filter((ln) => {
    const t = ln.trim();
    if (t === "") return false;
    if (t.startsWith("import ") || t.startsWith("import{")) return false;
    return true;
  });
  let excerpt = filtered.join("\n");
  if (excerpt.length > MAX_EXCERPT_CHARS) {
    excerpt = excerpt.slice(0, MAX_EXCERPT_CHARS);
  }
  return excerpt;
}

/**
 * Turn a file's route ("page /pricing", "component") plus a classification into
 * the roll-call role string, e.g. "h1 heading on /pricing" or "button/CTA label".
 */
function roleString(classification, route) {
  if (route && route.startsWith("page ")) {
    return `${classification} on ${route.slice("page ".length)}`;
  }
  return classification;
}

/**
 * Render the whole-namespace dossier text AND build the per-key role map.
 * Returns { text, roles } where roles is { "<ns>.<key>": "<role>" }.
 *
 * The dossier text is capped at MAX_FILES_PER_NS files and MAX_DOSSIER_CHARS
 * total (prefers files with the most call sites), but the role map is built
 * from EVERY file that uses the namespace so the roll call can annotate keys
 * even when their source file was trimmed out of the dossier text.
 */
export function renderDossier(ns) {
  const files = findNamespaceUsers(ns);
  const dossiers = [];
  for (const f of files) {
    const d = fileDossier(f);
    if (d) dossiers.push(d);
  }
  // Prefer files with most call sites.
  dossiers.sort((a, b) => b.callCount - a.callCount);

  // Role map across ALL files (not just the char-capped subset). First file to
  // classify a key wins; since dossiers are sorted by call count, the most-used
  // file's classification is preferred, which matches where the key most lives.
  const roles = {};
  for (const d of dossiers) {
    for (const c of d.callSites) {
      const cid = `${ns}.${c.key}`;
      if (!(cid in roles)) roles[cid] = roleString(c.classification, d.route);
    }
  }

  const chosen = dossiers.slice(0, MAX_FILES_PER_NS);
  const blocks = [];
  let total = 0;
  for (const d of chosen) {
    const header = `## ${d.rel} — ${d.route}`;
    const callLines = d.callSites
      .map((c, i) => `${i + 1}. ${c.key} → ${c.classification}`)
      .join("\n");
    const excerptBlock = d.excerpt ? "```tsx\n" + d.excerpt + "\n```" : "";
    const block = [header, callLines, excerptBlock].filter(Boolean).join("\n");
    if (total + block.length > MAX_DOSSIER_CHARS && blocks.length > 0) break;
    blocks.push(block);
    total += block.length;
  }
  return { text: blocks.join("\n\n"), roles };
}

// --------------------------------------------------------------------------- //
// Dossier cache keyed on involved file paths + mtimes + sizes.
// --------------------------------------------------------------------------- //

function sourceHash(ns) {
  const files = findNamespaceUsers(ns);
  const h = crypto.createHash("sha1");
  for (const f of files) {
    let st;
    try {
      st = fs.statSync(f);
    } catch {
      continue;
    }
    h.update(f);
    h.update(String(st.mtimeMs));
    h.update(String(st.size));
  }
  return h.digest("hex");
}

let _cache = null;
function loadCache() {
  if (_cache) return _cache;
  ensureCacheDir();
  try {
    _cache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
  } catch {
    _cache = {};
  }
  return _cache;
}
function saveCache() {
  ensureCacheDir();
  fs.writeFileSync(CACHE_FILE, JSON.stringify(_cache, null, 2) + "\n", "utf-8");
}

/**
 * Dossier + role map for a namespace, cached by involved-file hash.
 * Returns { text, roles }. Legacy cache entries (dossier only, no roles) are
 * treated as a miss so the role map gets populated.
 */
export function getDossierData(ns) {
  const cache = loadCache();
  const hash = sourceHash(ns);
  const hit = cache[ns];
  if (hit && hit.sourceHash === hash && hit.roles && typeof hit.roles === "object") {
    return { text: hit.dossier || "", roles: hit.roles };
  }
  const { text, roles } = renderDossier(ns);
  cache[ns] = { dossier: text, roles, sourceHash: hash };
  saveCache();
  return { text, roles };
}

/** Dossier text for a namespace (back-compat helper). */
export function getDossier(ns) {
  return getDossierData(ns).text;
}

/** { "<ns>.<key>": "<role>" } classification map for a namespace. */
export function getRoleMap(ns) {
  return getDossierData(ns).roles;
}

// --------------------------------------------------------------------------- //
// Voice samples — scored candidate pool per locale, computed once, cap 12.
// --------------------------------------------------------------------------- //

const _voicePools = new Map(); // locale -> [{score, value}]

function voicePool(locale, localeData) {
  if (_voicePools.has(locale)) return _voicePools.get(locale);
  const candidates = [];
  for (const [, items] of Object.entries(localeData)) {
    for (const v of Object.values(items)) {
      if (!v || v.length > 220) continue;
      candidates.push({ score: Math.abs(80 - v.length), value: v });
    }
  }
  candidates.sort((a, b) => a.score - b.score);
  _voicePools.set(locale, candidates);
  return candidates;
}

/**
 * Voice samples for a batch: dedup + cap 12, drawn from other namespaces.
 * Skipped entirely when the batch namespace already has >=15 non-empty locale
 * values (enough in-context register signal already).
 */
export function collectVoiceSamples(locale, localeData, batchNamespaces) {
  // Skip if any batch namespace is already dense with translations.
  for (const ns of batchNamespaces) {
    const items = localeData[ns] || {};
    const nonEmpty = Object.values(items).filter((v) => v).length;
    if (nonEmpty >= VOICE_SKIP_IF_NONEMPTY_GE) return [];
  }
  const pool = voicePool(locale, localeData);
  // Exclude values that live in the batch namespaces.
  const nsValues = new Set();
  for (const ns of batchNamespaces) {
    for (const v of Object.values(localeData[ns] || {})) if (v) nsValues.add(v);
  }
  const seen = new Set();
  const out = [];
  for (const { value } of pool) {
    if (nsValues.has(value)) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= VOICE_MAX_SAMPLES) break;
  }
  return out;
}

// --------------------------------------------------------------------------- //
// Glossary
// --------------------------------------------------------------------------- //

let _glossary = null;
function loadGlossary() {
  if (_glossary) return _glossary;
  try {
    _glossary = JSON.parse(fs.readFileSync(GLOSSARY_FILE, "utf-8"));
  } catch {
    _glossary = { brand: [], terms: {} };
  }
  return _glossary;
}

export function brandList() {
  return loadGlossary().brand || [];
}

/** Global style note (free text, applies to every locale), or null when unset. */
export function globalStyleNote() {
  const note = loadGlossary().style;
  return typeof note === "string" && note.trim() ? note.trim() : null;
}

/** [{ term, translation }] for entries that have a value for `locale`. */
export function glossaryTermsFor(locale) {
  const g = loadGlossary();
  const out = [];
  for (const [term, map] of Object.entries(g.terms || {})) {
    if (map && typeof map === "object" && map[locale]) {
      out.push({ term, translation: map[locale] });
    }
  }
  return out;
}

// --------------------------------------------------------------------------- //
// Context trimming — deterministic neighbor selection.
//
// When a namespace is large but only a few keys are stale, sending the whole
// EN namespace (and the whole existing-locale block) bloats the prompt. We keep
// all stale keys and add up to `budget` NON-stale extras chosen deterministically:
// prefer keys adjacent (in file order) to a stale key, then break ties by
// shortest value. Determinism matters so identical stale sets across locales
// produce identical shared prefixes for implicit caching.
// --------------------------------------------------------------------------- //

const EN_TRIM_MIN_KEYS = 60; // only trim EN JSON above this size
const EN_TRIM_BUDGET = 30; // non-stale EN neighbors kept
const LOCALE_CONTEXT_CAP = 30; // max existing-locale entries shown

/**
 * Choose up to `budget` non-stale keys from `orderedKeys` (file order) to keep
 * alongside the stale ones. Ranking, deterministic:
 *   1. distance in file order to the nearest stale key (closer first)
 *   2. value length (shorter first)
 *   3. file-order index (stable tiebreak)
 * `valueFor(key)` returns the string used for the length tiebreak.
 * Returns a Set of selected non-stale keys.
 */
export function selectNeighborKeys(orderedKeys, staleSet, budget, valueFor) {
  if (budget <= 0) return new Set();
  // Precompute distance to nearest stale key by index.
  const staleIdx = [];
  orderedKeys.forEach((k, i) => {
    if (staleSet.has(k)) staleIdx.push(i);
  });
  if (!staleIdx.length) return new Set();

  const candidates = [];
  orderedKeys.forEach((k, i) => {
    if (staleSet.has(k)) return;
    let dist = Infinity;
    for (const si of staleIdx) {
      const d = Math.abs(si - i);
      if (d < dist) dist = d;
    }
    candidates.push({ key: k, idx: i, dist, len: (valueFor(k) || "").length });
  });

  candidates.sort((a, b) => {
    if (a.dist !== b.dist) return a.dist - b.dist;
    if (a.len !== b.len) return a.len - b.len;
    return a.idx - b.idx;
  });

  const selected = new Set();
  for (const c of candidates) {
    if (selected.size >= budget) break;
    selected.add(c.key);
  }
  return selected;
}

/**
 * Trim the EN namespace object for the prompt. Returns the (possibly full)
 * object in ORIGINAL key order. Only trims when the namespace has more than
 * EN_TRIM_MIN_KEYS keys AND fewer than half are stale.
 * `nsObj`: { key: enValue }. `staleKeys`: string[] of keys to always keep.
 */
export function trimEnNamespace(nsObj, staleKeys) {
  const orderedKeys = Object.keys(nsObj);
  const total = orderedKeys.length;
  const staleSet = new Set(staleKeys);
  if (total <= EN_TRIM_MIN_KEYS || staleSet.size >= total / 2) {
    return nsObj; // keep full
  }
  const keep = selectNeighborKeys(
    orderedKeys,
    staleSet,
    EN_TRIM_BUDGET,
    (k) => nsObj[k]
  );
  const out = {};
  for (const k of orderedKeys) {
    if (staleSet.has(k) || keep.has(k)) out[k] = nsObj[k];
  }
  return out;
}

/**
 * Cap the existing-locale context object at LOCALE_CONTEXT_CAP entries, using
 * the same neighbor selection anchored on stale keys. `localeObj` already
 * contains only non-empty values (stale keys are empty so absent from it).
 * `orderedKeys` gives file order; `staleKeys` seed the neighbor anchors.
 */
export function trimLocaleContext(localeObj, orderedKeys, staleKeys) {
  const presentKeys = orderedKeys.filter((k) => k in localeObj);
  if (presentKeys.length <= LOCALE_CONTEXT_CAP) return localeObj;
  const staleSet = new Set(staleKeys);
  // Anchor neighbor selection on stale positions within the full file order,
  // then keep only the present (non-empty) keys among the winners.
  const keep = selectNeighborKeys(
    orderedKeys,
    staleSet,
    LOCALE_CONTEXT_CAP,
    (k) => localeObj[k] || ""
  );
  const out = {};
  for (const k of orderedKeys) {
    if (keep.has(k) && k in localeObj) out[k] = localeObj[k];
  }
  return out;
}

// --------------------------------------------------------------------------- //
// Prompt template. Cache-first ordering: everything before "# Target locale"
// is identical across all locales of the same namespace-set.
// --------------------------------------------------------------------------- //

/**
 * batch: { locale, namespaces: [ns...], staleKeys: [{ns, key}], enData, localeData }
 * Returns the full prompt string.
 */
export function buildPrompt(batch, enData, localeData) {
  const { locale, namespaces, staleKeys } = batch;
  const name = localeName(locale);
  const parts = [];

  // Stale keys grouped by namespace (used for both trimming and the roll call).
  const staleByNs = new Map();
  for (const { ns, key } of staleKeys) {
    if (!staleByNs.has(ns)) staleByNs.set(ns, []);
    staleByNs.get(ns).push(key);
  }

  // --- shared, LOCALE-NEUTRAL prefix (cacheable) ---
  parts.push(
    "You are a native-speaker UX copywriter shipping the localized version of the Scribe CMS marketing site (scribe.genlook.app). The target language is specified further down. You are NOT translating a document: the English strings tell you the INTENT, and your job is to write what a top-tier developer-tool site in the target language would actually say in that spot."
  );
  parts.push("");
  parts.push(
    "Scribe (scribe-cms) is a typed, git-based CMS for multilingual MDX sites with AI translation. The audience is developers evaluating and using the tool. Tone: precise, technical, confident, concise."
  );
  parts.push("");
  parts.push("# How to write (most important section)");
  parts.push(
    "- Write from intent, not from words. Read the English, look at the string's ROLE on the page (given for every key in the final list), then write the line the way a native copywriter would. When a word-for-word rendering and a natural rendering differ, ALWAYS ship the natural one."
  );
  parts.push(
    "- Never mirror English sentence structure when the target language phrases the idea differently. Calqued syntax is the #1 failure mode of this task."
  );
  parts.push(
    "- Headings, taglines and CTAs are the showcase: punchy, idiomatic, natural word order for the target language. Rewrite freely as long as the intent and the punch survive."
  );
  parts.push(
    "- Body and FAQ text: accurate and complete, but in native rhythm — split or merge sentences whenever the target language calls for it."
  );
  parts.push(
    "- Aim within ±25% of the source length (UI layout depends on it), but a shorter natural phrasing always beats a literal same-length one."
  );
  parts.push(
    "- Use the target language's natural punctuation and number formats (full-width punctuation in CJK, French spaces before `:` `?` `!`, decimal commas where applicable, etc.)."
  );
  parts.push(
    "- Stay terminologically consistent with the terminology table and the existing strings shown below — vocabulary must round-trip across the whole site."
  );

  // Global style note (glossary.json `style`) — locale-neutral, so it lives in
  // the shared header and extends the cacheable prefix.
  const styleNote = globalStyleNote();
  if (styleNote) {
    parts.push("");
    parts.push("# Style");
    parts.push(styleNote);
  }

  parts.push("");
  parts.push("# Hard rules (non-negotiable)");
  parts.push("- Output JSON ONLY — schema is enforced. No prose, no fences, no commentary.");
  parts.push(
    "- Preserve placeholder syntax verbatim: `{name}`, `{count}`, `{count, plural, =0 {none} one {# item} other {# items}}`, etc. Do NOT translate placeholder names. Do NOT add or remove placeholders."
  );
  parts.push("- Preserve inline Markdown / HTML exactly (`**bold**`, `<a href>`, `<br />`).");
  parts.push(
    "- Never use em dashes (—) in the output. Rephrase instead: use a comma, parentheses, a colon, or split into separate sentences."
  );
  parts.push(
    "- Preserve URLs, emails, file paths, brand names, version numbers, and numbers verbatim."
  );
  parts.push(
    `- Never translate these brand terms (keep exact casing): ${brandList().join(", ")}.`
  );

  // Per-namespace source blocks (shared across locales, locale-neutral).
  for (const ns of namespaces) {
    const nsStale = staleByNs.get(ns) || [];
    const nsObj = enData[ns] || {};
    const trimmed = trimEnNamespace(nsObj, nsStale);
    parts.push("");
    parts.push(`# Namespace \`${ns}\` — English source`);
    parts.push("```json");
    parts.push(JSON.stringify(trimmed, null, 2));
    parts.push("```");
    parts.push("");
    parts.push("# Where these strings appear (per source file, in page order)");
    const dossier = getDossier(ns);
    parts.push(dossier || "(no source files found using this namespace)");
  }

  // --- locale-specific zone (everything below is per-locale) ---
  parts.push("");
  parts.push(`# Target locale: ${name} (${locale})`);

  const terms = glossaryTermsFor(locale);
  if (terms.length) {
    parts.push("");
    parts.push(
      `# Established ${name} terminology (use these translations for these terms, consistently)`
    );
    for (const { term, translation } of terms) {
      parts.push(`- "${term}" → "${translation}"`);
    }
  }

  for (const ns of namespaces) {
    parts.push("");
    parts.push(
      `# Existing ${name} translations for \`${ns}\` (context only — already final, match their register and vocabulary)`
    );
    const items = localeData[ns] || {};
    const nonEmpty = {};
    for (const [k, v] of Object.entries(items)) if (v) nonEmpty[k] = v;
    const orderedKeys = Object.keys(enData[ns] || {});
    const capped = trimLocaleContext(nonEmpty, orderedKeys, staleByNs.get(ns) || []);
    parts.push("```json");
    parts.push(JSON.stringify(capped, null, 2));
    parts.push("```");
  }

  const voice = collectVoiceSamples(locale, localeData, namespaces);
  if (voice.length) {
    parts.push("");
    parts.push(
      `# Brand-voice anchor — representative ${name} strings from other pages (match the register)`
    );
    for (const v of voice) {
      parts.push(`- ${JSON.stringify(v)}`);
    }
  }

  // Per-namespace role maps for the roll call.
  const roleMaps = new Map();
  for (const ns of namespaces) roleMaps.set(ns, getRoleMap(ns));

  parts.push("");
  parts.push(`# Keys to translate (${staleKeys.length} total)`);
  for (const { ns, key } of staleKeys) {
    const enVal = (enData[ns] && enData[ns][key]) || "";
    // Roles are classified at the call site, where next-intl keys are the raw
    // English strings (content-hashed to the short JSON keys only at build).
    // So the role map is keyed by `<ns>.<EN string>`; look up by enVal.
    const roleMap = roleMaps.get(ns) || {};
    const role = roleMap[`${ns}.${enVal}`] || "unclassified";
    parts.push(`- \`${ns}.${key}\` (${role}) ← ${JSON.stringify(enVal)}`);
  }

  parts.push("");
  parts.push("# Output");
  parts.push(
    `Return a SINGLE JSON object containing ONLY the keys listed above, with their localized values, written as native ${name} UX copy. Do not include any other key. No commentary.`
  );

  return parts.join("\n");
}
