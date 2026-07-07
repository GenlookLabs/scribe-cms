import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StudioCache } from "./studio-cache.js";

/**
 * A manual scheduler: background jobs are queued instead of run, so tests can
 * flush them deterministically and assert on the stale-while-revalidate timing.
 */
function manualScheduler() {
  const queue: Array<() => void> = [];
  return {
    schedule: (job: () => void) => queue.push(job),
    /** Run every queued job (jobs may enqueue follow-ups; drain fully). */
    flush() {
      while (queue.length > 0) queue.shift()!();
    },
    get pending() {
      return queue.length;
    },
  };
}

describe("StudioCache", () => {
  it("builds synchronously on first get() when no placeholder is provided", () => {
    let builds = 0;
    const cache = new StudioCache<string>({
      fingerprint: () => "a",
      build: () => `built#${++builds}`,
    });
    assert.equal(cache.get(), "built#1");
    assert.equal(builds, 1);
    // Same fingerprint → served from cache, no rebuild.
    assert.equal(cache.get(), "built#1");
    assert.equal(builds, 1);
  });

  it("serves the placeholder first, then the real build off the hot path (boot warm-up path)", () => {
    const sched = manualScheduler();
    let builds = 0;
    const cache = new StudioCache<string>({
      fingerprint: () => "a",
      build: () => `built#${++builds}`,
      initial: () => "placeholder",
      schedule: sched.schedule,
    });

    // First get() (e.g. the boot warm-up) never blocks: placeholder now, build queued.
    assert.equal(cache.get(), "placeholder");
    assert.equal(builds, 0);
    assert.equal(sched.pending, 1);

    // Background build runs (as it would shortly after boot).
    sched.flush();
    assert.equal(builds, 1);
    // Subsequent requests see the real value without scheduling more work.
    assert.equal(cache.get(), "built#1");
    assert.equal(sched.pending, 0);
  });

  it("revalidates in the background when the fingerprint changes (dev content edits)", () => {
    const sched = manualScheduler();
    let fingerprint = "v1";
    let builds = 0;
    const cache = new StudioCache<string>({
      fingerprint: () => fingerprint,
      build: () => `${fingerprint}#${++builds}`,
      schedule: sched.schedule,
    });

    // Prime (synchronous first build).
    assert.equal(cache.get(), "v1#1");

    // Content changes on disk → fingerprint changes.
    fingerprint = "v2";
    // Stale value served immediately; rebuild scheduled, not run inline.
    assert.equal(cache.get(), "v1#1");
    assert.equal(sched.pending, 1);

    // Background rebuild lands → fresh value next time (no restart needed).
    sched.flush();
    assert.equal(cache.get(), "v2#2");
    assert.equal(builds, 2);
  });

  it("dedupes concurrent rebuilds and chases the newest fingerprint", () => {
    const sched = manualScheduler();
    let fingerprint = "v1";
    let builds = 0;
    const cache = new StudioCache<string>({
      fingerprint: () => fingerprint,
      build: () => `${fingerprint}#${++builds}`,
      schedule: sched.schedule,
    });
    assert.equal(cache.get(), "v1#1");

    fingerprint = "v2";
    cache.get(); // schedules a rebuild for v2
    fingerprint = "v3"; // another change before the rebuild runs
    cache.get(); // must not schedule a redundant parallel build
    assert.equal(sched.pending, 1);

    sched.flush(); // builds v3, then chases to settle on the newest state
    assert.equal(cache.get(), "v3#2");
    assert.equal(builds, 2);
  });

  it("keeps serving the last good value when a background rebuild throws", () => {
    const sched = manualScheduler();
    let fingerprint = "v1";
    let shouldThrow = false;
    const errors: unknown[] = [];
    const cache = new StudioCache<string>({
      fingerprint: () => fingerprint,
      build: () => {
        if (shouldThrow) throw new Error("build failed");
        return fingerprint;
      },
      schedule: sched.schedule,
      onError: (e) => errors.push(e),
    });
    assert.equal(cache.get(), "v1");

    fingerprint = "v2";
    shouldThrow = true;
    cache.get();
    sched.flush();
    // Failed rebuild is reported and the previous value is still served.
    assert.equal(errors.length, 1);
    assert.equal(cache.get(), "v1");
  });
});
