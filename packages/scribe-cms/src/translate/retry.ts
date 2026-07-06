import { ApiError } from "@google/genai";

/** HTTP status codes worth retrying: rate limiting + transient server errors. */
const TRANSIENT_STATUS = new Set([429, 500, 502, 503, 504]);

function statusFromError(error: unknown): number | undefined {
  if (error instanceof ApiError && typeof error.status === "number") {
    return error.status;
  }
  // Some SDK paths surface a plain object/error with a numeric `status`.
  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number") return status;
  }
  // Fall back to matching a status code embedded in the message.
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/\b(429|500|502|503|504)\b/);
  if (match) return Number(match[1]);
  return undefined;
}

function isNetworkError(error: unknown): boolean {
  const err = error as { code?: unknown; name?: unknown } | null;
  const code = typeof err?.code === "string" ? err.code : "";
  if (
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "ECONNREFUSED" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    code === "EPIPE" ||
    code === "UND_ERR_SOCKET"
  ) {
    return true;
  }
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return (
    message.includes("network") ||
    message.includes("fetch failed") ||
    message.includes("socket hang up") ||
    message.includes("terminated")
  );
}

/** Classify whether an error is transient and safe to retry. */
export function isTransientError(error: unknown): boolean {
  const status = statusFromError(error);
  if (status !== undefined) return TRANSIENT_STATUS.has(status);
  return isNetworkError(error);
}

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  /** Injectable sleep for tests; defaults to real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable jitter in [0, 1); defaults to Math.random. */
  random?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn` with exponential backoff + jitter, retrying only transient failures
 * (HTTP 429/5xx and network errors). Non-transient errors throw immediately.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const baseDelayMs = options.baseDelayMs ?? 1000;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isTransientError(error)) throw error;
      // Exponential backoff with full jitter: attempt 1 -> ~1s, attempt 2 -> ~2-4s.
      const backoff = baseDelayMs * 2 ** (attempt - 1);
      const delay = backoff + random() * backoff;
      await sleep(delay);
    }
  }
  throw lastError;
}
