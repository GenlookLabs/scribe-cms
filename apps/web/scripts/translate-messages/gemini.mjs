// Gemini API client + pricing + model registry. Zero deps, built-in fetch only.

// --------------------------------------------------------------------------- //
// Pricing — display_name -> { input: [le_200k, gt_200k], output: [le_200k, gt_200k] }
// USD per 1M tokens. Tier breakpoint is the prompt (input) token count: once a
// single prompt exceeds 200k tokens, BOTH input and output bill at the higher
// rate. Batch mode = 50% of every rate. Unknown model => null cost.
// --------------------------------------------------------------------------- //

export const GEMINI_PRICING_USD = {
  "gemini-3.1-pro": { input: [2.0, 4.0], output: [12.0, 18.0] },
};

export const TIER_THRESHOLD_TOKENS = 200_000;

/**
 * Total cost in USD for a single call. Returns null when no pricing is known.
 * `batch` applies the 50% batch-API discount to every rate.
 */
export function estimateCost(model, tokensIn, tokensOut, { batch = false } = {}) {
  const rates = GEMINI_PRICING_USD[model];
  if (!rates) return null;
  const [inLe, inGt] = rates.input;
  const [outLe, outGt] = rates.output;
  const overTier = tokensIn > TIER_THRESHOLD_TOKENS;
  let inRate = overTier ? inGt : inLe;
  let outRate = overTier ? outGt : outLe;
  if (batch) {
    inRate *= 0.5;
    outRate *= 0.5;
  }
  return (tokensIn / 1_000_000) * inRate + (tokensOut / 1_000_000) * outRate;
}

/** Format a cost with the same thresholds as the Python format_cost. */
export function formatCost(costUsd) {
  if (costUsd === null || costUsd === undefined) return "—";
  if (costUsd < 0.001) return `$${costUsd.toFixed(5)}`;
  if (costUsd < 0.01) return `$${costUsd.toFixed(4)}`;
  if (costUsd < 0.1) return `$${costUsd.toFixed(3)}`;
  return `$${costUsd.toFixed(3)}`;
}

// --------------------------------------------------------------------------- //
// Model registry
// --------------------------------------------------------------------------- //

export const AVAILABLE_MODELS = {
  "gemini-2.5-pro": "gemini-2.5-pro",
  "gemini-3.1-pro": "gemini-3.1-pro-preview",
};

export const DEFAULT_MODEL = "gemini-3.1-pro";

/** Map a display name to the API model id (falls back to the name itself). */
export function resolveModelId(displayName) {
  return AVAILABLE_MODELS[displayName] || displayName;
}

// --------------------------------------------------------------------------- //
// HTTP client
// --------------------------------------------------------------------------- //

const BASE = "https://generativelanguage.googleapis.com";

// Module-level flag: once the API rejects thinkingConfig, skip it for the run.
let SKIP_THINKING_CONFIG = false;

function apiKey() {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY (or GOOGLE_API_KEY) is not set");
  return key;
}

function headers(extra = {}) {
  return { "x-goog-api-key": apiKey(), ...extra };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isRetryable(status, err) {
  if (err) return true; // network error
  if (status === 429) return true;
  if (status >= 500 && status <= 599) return true;
  return false;
}

/**
 * fetch with 3 attempts, exponential backoff 2s / 8s + jitter, retrying on
 * 429, 5xx and network errors.
 */
async function fetchRetry(url, init, { attempts = 3 } = {}) {
  const backoffs = [2000, 8000];
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    let res;
    try {
      res = await fetch(url, init);
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1 && isRetryable(0, err)) {
        await sleep(backoffs[Math.min(i, backoffs.length - 1)] + Math.random() * 500);
        continue;
      }
      throw err;
    }
    if (res.ok) return res;
    const body = await res.text().catch(() => "");
    if (i < attempts - 1 && isRetryable(res.status, null)) {
      await sleep(backoffs[Math.min(i, backoffs.length - 1)] + Math.random() * 500);
      continue;
    }
    const e = new Error(`HTTP ${res.status}: ${body.slice(0, 500)}`);
    e.status = res.status;
    e.body = body;
    throw e;
  }
  throw lastErr;
}

function thinkingLevelFor(thinking) {
  // Accept low | medium | high, pass through verbatim.
  return thinking;
}

/**
 * generateContent — paid. Returns { parsed, usage }.
 * usage = { promptTokenCount, candidatesTokenCount, thoughtsTokenCount, cachedContentTokenCount }.
 *
 * thinkingConfig resilience: we send generationConfig.thinkingConfig.thinkingLevel
 * (camelCase, v1beta REST convention). If the API 400s mentioning
 * thinkingConfig/thinkingLevel, retry ONCE without it and skip it for the run.
 */
export async function generateContent(modelId, prompt, schema, thinking) {
  const url = `${BASE}/v1beta/models/${modelId}:generateContent`;

  const buildBody = (withThinking) => {
    const generationConfig = {
      responseMimeType: "application/json",
      responseSchema: schema,
    };
    if (withThinking && !SKIP_THINKING_CONFIG && thinking) {
      generationConfig.thinkingConfig = { thinkingLevel: thinkingLevelFor(thinking) };
    }
    return {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig,
    };
  };

  const doCall = async (withThinking) => {
    const res = await fetchRetry(url, {
      method: "POST",
      headers: headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(buildBody(withThinking)),
    });
    return res.json();
  };

  let json;
  try {
    json = await doCall(true);
  } catch (err) {
    const msg = String(err.body || err.message || "");
    if (
      err.status === 400 &&
      !SKIP_THINKING_CONFIG &&
      thinking &&
      /thinkingConfig|thinkingLevel|thinking_level/i.test(msg)
    ) {
      SKIP_THINKING_CONFIG = true;
      json = await doCall(false);
    } else {
      throw err;
    }
  }

  return parseGenerateResponse(json);
}

/** Parse a GenerateContentResponse JSON body into { parsed, usage }. */
export function parseGenerateResponse(json) {
  const cand = json?.candidates?.[0];
  const parts = cand?.content?.parts || [];
  const text = parts.map((p) => p.text || "").join("");
  let parsed = {};
  try {
    parsed = JSON.parse(text || "{}");
  } catch {
    parsed = {};
  }
  const m = json?.usageMetadata || {};
  const usage = {
    promptTokenCount: Number(m.promptTokenCount || 0),
    candidatesTokenCount: Number(m.candidatesTokenCount || 0),
    thoughtsTokenCount: Number(m.thoughtsTokenCount || 0),
    cachedContentTokenCount: Number(m.cachedContentTokenCount || 0),
  };
  return { parsed, usage };
}

/** countTokens — free. Returns totalTokens. */
export async function countTokens(modelId, prompt) {
  const url = `${BASE}/v1beta/models/${modelId}:countTokens`;
  const res = await fetchRetry(url, {
    method: "POST",
    headers: headers({ "Content-Type": "application/json" }),
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });
  const json = await res.json();
  return Number(json?.totalTokens || 0);
}

// --------------------------------------------------------------------------- //
// Batch API
// --------------------------------------------------------------------------- //

/**
 * Resumable upload of a JSONL payload (array of stringified lines or a single
 * string). Returns the file resource name (files/...).
 */
export async function uploadJsonl(lines) {
  const body = Array.isArray(lines) ? lines.join("\n") + "\n" : lines;
  const bytes = Buffer.byteLength(body, "utf-8");

  // 1) start resumable session
  const startRes = await fetchRetry(`${BASE}/upload/v1beta/files`, {
    method: "POST",
    headers: headers({
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(bytes),
      "X-Goog-Upload-Header-Content-Type": "application/jsonl",
      "Content-Type": "application/json",
    }),
    body: JSON.stringify({ file: { display_name: "translate-messages-batch" } }),
  });
  const uploadUrl = startRes.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new Error("resumable upload: no upload URL returned");

  // 2) upload + finalize in one request
  const upRes = await fetchRetry(uploadUrl, {
    method: "POST",
    headers: headers({
      "X-Goog-Upload-Command": "upload, finalize",
      "X-Goog-Upload-Offset": "0",
      "Content-Type": "application/jsonl",
      "Content-Length": String(bytes),
    }),
    body,
  });
  const json = await upRes.json();
  const name = json?.file?.name;
  if (!name) throw new Error("resumable upload: no file.name in response");
  return name;
}

/**
 * Build one JSONL request line. `schema` is the responseSchema (snake_case keys
 * inside `request` per batch API). NO thinkingConfig in batch mode.
 */
export function batchJsonlLine(key, prompt, schema) {
  return JSON.stringify({
    key,
    request: {
      contents: [{ parts: [{ text: prompt }] }],
      generation_config: {
        response_mime_type: "application/json",
        response_schema: schema,
      },
    },
  });
}

/** Create a batch job. Returns the batch name ("batches/..."). */
export async function createBatch(modelId, fileName) {
  const url = `${BASE}/v1beta/models/${modelId}:batchGenerateContent`;
  const res = await fetchRetry(url, {
    method: "POST",
    headers: headers({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      batch: {
        display_name: `translate-messages ${new Date().toISOString()}`,
        input_config: { file_name: fileName },
      },
    }),
  });
  const json = await res.json();
  const name = json?.name;
  if (!name) throw new Error("createBatch: no name in response");
  return name;
}

/** Get batch metadata. Returns the raw operation/batch JSON. */
export async function getBatch(name) {
  const res = await fetchRetry(`${BASE}/v1beta/${name}`, {
    method: "GET",
    headers: headers(),
  });
  return res.json();
}

/** Extract the state string from a getBatch response. */
export function batchState(json) {
  return json?.metadata?.state || json?.state || "JOB_STATE_UNKNOWN";
}

/** Cancel a batch job. */
export async function cancelBatch(name) {
  const res = await fetchRetry(`${BASE}/v1beta/${name}:cancel`, {
    method: "POST",
    headers: headers({ "Content-Type": "application/json" }),
    body: "{}",
  });
  return res.json().catch(() => ({}));
}

/**
 * Download the responses file for a finished batch. Returns an array of parsed
 * JSONL objects, each with our `key` and either a response or an error/status.
 */
export async function downloadBatchResults(json) {
  const responsesFile =
    json?.response?.batch?.output?.responsesFile ||
    json?.metadata?.output?.responsesFile ||
    json?.response?.output?.responsesFile ||
    json?.response?.responsesFile;
  if (!responsesFile) throw new Error("batch results: no responsesFile in response");
  const res = await fetchRetry(
    `${BASE}/download/v1beta/${responsesFile}:download?alt=media`,
    { method: "GET", headers: headers() }
  );
  const text = await res.text();
  const out = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // skip malformed lines
    }
  }
  return out;
}

export { SKIP_THINKING_CONFIG };
