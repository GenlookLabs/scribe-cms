import fs from "node:fs";
import path from "node:path";
import type { ScribeConfig, ScribeProject } from "../src/core/types.js";

/**
 * Content-fingerprint driven cache for the read-only studio.
 *
 * The studio derives three things from content that are far too expensive to
 * recompute on every request against a real project (hundreds of docs × a dozen
 * locales):
 *
 *   - the back-reference index (relations)
 *   - the asset-reference graph
 *   - the validation report (drives the advisory badges)
 *
 * The validation report in particular parses every EN + translated MDX body
 * through remark/unified, which is multiple seconds on a large project. Doing
 * that synchronously inside the request that happened to arrive right after a
 * content change made `/types/:id` block for ~5s — the reported slowness.
 *
 * This module rebuilds the derived data ONCE per content-change tick (a cheap
 * `count:newestMtime:storeMtime` fingerprint) and serves it *stale-while-
 * revalidate*: a request never blocks on a rebuild once a cache exists. When the
 * fingerprint changes the current (stale) value is returned immediately and a
 * single background rebuild is kicked off; the next request after it lands sees
 * the fresh data. Only the very first build (no cache yet) runs synchronously so
 * there is always something to render.
 *
 * The badges are advisory, so a few hundred ms of staleness after an edit is an
 * acceptable trade for never blocking the browser. Edits are still reflected
 * without a restart — the fingerprint invalidation drives the refresh.
 *
 * Everything is injectable (clock + builder) so the invalidation/refresh logic
 * is unit-testable without a filesystem or a real remark parse.
 */

export interface StudioCacheData<T> {
  fingerprint: string;
  value: T;
}

export interface StudioCacheOptions<T> {
  /** Compute the current content fingerprint (file counts + newest mtime + store mtime). */
  fingerprint: () => string;
  /** Build the derived value for the current content. Expensive; run off the hot path. */
  build: () => T;
  /**
   * Cheap placeholder served on the very first request while the first real
   * build runs in the background. When provided, no request ever blocks on a
   * build; when omitted, the first `get()` builds synchronously so callers that
   * need a fully-populated value on first paint still work.
   */
  initial?: () => T;
  /** Injectable error sink (defaults to console.error). */
  onError?: (err: unknown) => void;
  /** Schedule a background job (defaults to `queueMicrotask` → `setImmediate` fallback). */
  schedule?: (job: () => void) => void;
}

function defaultSchedule(job: () => void): void {
  // Run after the current response has been handed off. `setImmediate` yields to
  // the event loop first (so the in-flight request flushes), falling back to
  // `queueMicrotask` where it is unavailable.
  if (typeof setImmediate === "function") setImmediate(job);
  else queueMicrotask(job);
}

/**
 * A fingerprint-keyed value that is rebuilt lazily and refreshed in the
 * background. `get()` is non-blocking whenever a value already exists.
 */
export class StudioCache<T> {
  private current: StudioCacheData<T> | null = null;
  private building = false;
  /** Fingerprint of the in-flight background build, to avoid redundant rebuilds. */
  private pendingFingerprint: string | null = null;

  constructor(private readonly opts: StudioCacheOptions<T>) {}

  /**
   * Return the freshest cached value without blocking (once a value exists).
   *
   * - No cache yet → build synchronously once (blocking, unavoidable).
   * - Fingerprint unchanged → return cached value.
   * - Fingerprint changed → return the stale value now, schedule a background
   *   rebuild (deduped by fingerprint) so the next request sees fresh data.
   */
  get(): T {
    const fingerprint = this.opts.fingerprint();

    if (!this.current) {
      if (this.opts.initial) {
        // Cold, but a cheap placeholder is available: serve it and build for
        // real in the background. Tag it with a sentinel fingerprint so the
        // scheduled build (and any future change) is always seen as newer.
        this.current = { fingerprint: "\u0000uninitialized", value: this.opts.initial() };
        this.scheduleRefresh(fingerprint);
        return this.current.value;
      }
      // No placeholder: build once on the request thread so first paint is complete.
      this.current = { fingerprint, value: this.runBuild() };
      return this.current.value;
    }

    if (this.current.fingerprint !== fingerprint) {
      this.scheduleRefresh(fingerprint);
    }
    return this.current.value;
  }

  /** True when a background rebuild is currently in flight (for tests/introspection). */
  get isRefreshing(): boolean {
    return this.building;
  }

  /**
   * Drop the cached value so the next `get()` rebuilds synchronously. Used after
   * a mutation (e.g. an entry deletion) so derived data — back-refs, badges,
   * validation — reflects the change on the very next request rather than after
   * the next background tick.
   */
  invalidate(): void {
    this.current = null;
    this.pendingFingerprint = null;
  }

  private scheduleRefresh(fingerprint: string): void {
    // Dedupe: one in-flight rebuild per target fingerprint.
    if (this.building && this.pendingFingerprint === fingerprint) return;
    if (this.building) {
      // A build for an older fingerprint is running; remember the newest target
      // so we rebuild again once it settles.
      this.pendingFingerprint = fingerprint;
      return;
    }
    this.building = true;
    this.pendingFingerprint = fingerprint;
    const schedule = this.opts.schedule ?? defaultSchedule;
    schedule(() => this.refreshNow());
  }

  private refreshNow(): void {
    // Recompute the fingerprint at build time so we tag the value with the state
    // we actually observed, and can detect further changes that landed meanwhile.
    const fingerprint = this.opts.fingerprint();
    try {
      this.current = { fingerprint, value: this.runBuild() };
    } catch (err) {
      (this.opts.onError ?? ((e) => console.error(e)))(err);
    } finally {
      this.building = false;
      const target = this.pendingFingerprint;
      this.pendingFingerprint = null;
      // Content changed again while we were building — chase it.
      if (target !== null && target !== fingerprint) {
        this.scheduleRefresh(target);
      }
    }
  }

  private runBuild(): T {
    return this.opts.build();
  }
}

/**
 * Cheap content fingerprint: total file count across all type content dirs, the
 * newest file mtime, and the store mtime. A change to any of these triggers a
 * rebuild. Pure read of `fs.stat` — never throws.
 */
export function computeContentFingerprint(project: ScribeProject, config: ScribeConfig): string {
  let newest = 0;
  let count = 0;
  for (const type of project.listTypes()) {
    try {
      const dir = path.join(config.rootDir, type.config.contentDir);
      for (const name of fs.readdirSync(dir)) {
        try {
          newest = Math.max(newest, fs.statSync(path.join(dir, name)).mtimeMs);
          count++;
        } catch {
          /* ignore unreadable entry */
        }
      }
    } catch {
      /* ignore missing dir */
    }
  }
  let store = 0;
  try {
    store = fs.statSync(config.storePath).mtimeMs;
  } catch {
    /* ignore missing store */
  }
  return `${count}:${newest}:${store}`;
}
