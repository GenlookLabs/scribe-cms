import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ApiError } from "@google/genai";
import { isTransientError, withRetry } from "./retry.js";

describe("isTransientError", () => {
  it("retries rate limits and transient server errors from ApiError", () => {
    for (const status of [429, 500, 502, 503, 504]) {
      assert.equal(isTransientError(new ApiError({ message: "boom", status })), true, `status ${status}`);
    }
  });

  it("does not retry client/auth errors", () => {
    for (const status of [400, 401, 403, 404]) {
      assert.equal(isTransientError(new ApiError({ message: "boom", status })), false, `status ${status}`);
    }
  });

  it("falls back to a status code embedded in the message", () => {
    assert.equal(isTransientError(new Error("got status 503 Service Unavailable")), true);
    assert.equal(isTransientError(new Error("Invalid JSON payload received")), false);
  });

  it("prefers an explicit status over message matching", () => {
    // A 400 whose message mentions "500" must still be non-transient.
    assert.equal(isTransientError(new ApiError({ message: "field must be < 500", status: 400 })), false);
  });

  it("retries network-level errors", () => {
    assert.equal(isTransientError(Object.assign(new Error("boom"), { code: "ECONNRESET" })), true);
    assert.equal(isTransientError(new Error("fetch failed")), true);
    assert.equal(isTransientError(new Error("socket hang up")), true);
  });
});

describe("withRetry", () => {
  const noSleep = () => Promise.resolve();

  it("retries transient failures and eventually succeeds", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new ApiError({ message: "overloaded", status: 503 });
        return "ok";
      },
      { sleep: noSleep, random: () => 0 },
    );
    assert.equal(result, "ok");
    assert.equal(calls, 3);
  });

  it("fails immediately on non-transient errors", async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(
        async () => {
          calls += 1;
          throw new ApiError({ message: "bad schema", status: 400 });
        },
        { sleep: noSleep },
      ),
      /bad schema/,
    );
    assert.equal(calls, 1);
  });

  it("gives up after the configured number of attempts", async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(
        async () => {
          calls += 1;
          throw new ApiError({ message: "still overloaded", status: 429 });
        },
        { attempts: 3, sleep: noSleep, random: () => 0 },
      ),
      /still overloaded/,
    );
    assert.equal(calls, 3);
  });

  it("backs off exponentially with jitter", async () => {
    const delays: number[] = [];
    await assert.rejects(
      withRetry(
        async () => {
          throw new ApiError({ message: "throttled", status: 429 });
        },
        {
          attempts: 3,
          baseDelayMs: 1000,
          sleep: async (ms) => {
            delays.push(ms);
          },
          random: () => 0.5,
        },
      ),
    );
    // attempt 1 -> 1000 + 0.5*1000, attempt 2 -> 2000 + 0.5*2000
    assert.deepEqual(delays, [1500, 3000]);
  });
});
