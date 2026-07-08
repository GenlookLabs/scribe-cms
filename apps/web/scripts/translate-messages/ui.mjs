// Hand-rolled ANSI UI: live dashboard, batch-mode spinner, estimate table,
// final summary. No dependencies. Degrades to plain lines on non-TTY.

import { formatCost } from "./gemini.mjs";

const isTTY = () => process.stdout.isTTY === true;

// ANSI helpers.
const ESC = "\x1b[";
const green = (s) => (isTTY() ? `${ESC}32m${s}${ESC}0m` : s);
const red = (s) => (isTTY() ? `${ESC}31m${s}${ESC}0m` : s);
const bold = (s) => (isTTY() ? `${ESC}1m${s}${ESC}0m` : s);

function fmtTokens(n) {
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

function fmtElapsed(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m > 0) return `${m}m${String(rem).padStart(2, "0")}s`;
  return `${rem}s`;
}

function pad(s, w) {
  s = String(s);
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}
function padL(s, w) {
  s = String(s);
  return s.length >= w ? s : " ".repeat(w - s.length) + s;
}

// --------------------------------------------------------------------------- //
// Pre-flight estimate table (also the whole --dry-run output).
// --------------------------------------------------------------------------- //

/**
 * rows: [{ locale, batches, staleKeys, inputTokens, outputTokens, cost }]
 * modeLine: string e.g. "mode: batch (50% off) — estimated $0.42 (live would be ~$0.84)"
 */
export function printEstimateTable(rows, modeLine) {
  console.log(bold("Pre-flight estimate"));
  const header = [
    pad("locale", 8),
    padL("batches", 8),
    padL("stale", 7),
    padL("in-tok", 10),
    padL("out-tok~", 10),
    padL("cost~", 10),
  ].join("  ");
  console.log(header);
  console.log("-".repeat(header.length));

  let tBatches = 0,
    tStale = 0,
    tIn = 0,
    tOut = 0,
    tCost = 0;
  let anyCost = false;
  for (const r of rows) {
    tBatches += r.batches;
    tStale += r.staleKeys;
    tIn += r.inputTokens;
    tOut += r.outputTokens;
    if (r.cost !== null && r.cost !== undefined) {
      tCost += r.cost;
      anyCost = true;
    }
    console.log(
      [
        pad(r.locale, 8),
        padL(r.batches, 8),
        padL(r.staleKeys, 7),
        padL(fmtTokens(r.inputTokens), 10),
        padL(fmtTokens(r.outputTokens), 10),
        padL(formatCost(r.cost), 10),
      ].join("  ")
    );
  }
  console.log("-".repeat(header.length));
  console.log(
    [
      pad("TOTAL", 8),
      padL(tBatches, 8),
      padL(tStale, 7),
      padL(fmtTokens(tIn), 10),
      padL(fmtTokens(tOut), 10),
      padL(anyCost ? formatCost(tCost) : "—", 10),
    ].join("  ")
  );
  console.log("");
  console.log(modeLine);
}

// --------------------------------------------------------------------------- //
// Live dashboard (redrawn in place on TTY, plain lines otherwise).
// --------------------------------------------------------------------------- //

export class LiveDashboard {
  constructor({ totalBatches, estCost }) {
    this.startedAt = Date.now();
    this.totalBatches = totalBatches;
    this.doneBatches = 0;
    this.tokensIn = 0;
    this.tokensOut = 0;
    this.cost = 0;
    this.estCost = estCost;
    this.locales = new Map(); // locale -> { done, total, in, out, cost }
    this.errors = [];
    this._lastLineCount = 0;
    this._tty = isTTY();
  }

  registerLocale(locale, total) {
    if (!this.locales.has(locale)) {
      this.locales.set(locale, { done: 0, total, in: 0, out: 0, cost: 0 });
    } else {
      this.locales.get(locale).total += total;
    }
  }

  onBatchDone(locale, { tokensIn, tokensOut, cost }) {
    this.doneBatches++;
    this.tokensIn += tokensIn;
    this.tokensOut += tokensOut;
    if (cost !== null && cost !== undefined) this.cost += cost;
    const l = this.locales.get(locale);
    if (l) {
      l.done++;
      l.in += tokensIn;
      l.out += tokensOut;
      if (cost !== null && cost !== undefined) l.cost += cost;
    }
    this.render();
  }

  onError(msg) {
    this.errors.push(msg);
    this.render();
  }

  _lines() {
    const elapsed = fmtElapsed(Date.now() - this.startedAt);
    const lines = [];
    lines.push(
      `${elapsed} | batches ${this.doneBatches}/${this.totalBatches} | ` +
        `tokens in ${fmtTokens(this.tokensIn)}/out ${fmtTokens(this.tokensOut)} | ` +
        `cost ${formatCost(this.cost)} (est ${formatCost(this.estCost)})`
    );
    for (const [locale, l] of this.locales) {
      const ratio = l.total ? l.done / l.total : 0;
      const filled = Math.round(ratio * 10);
      const bar = "█".repeat(filled) + "░".repeat(10 - filled);
      const done = l.done >= l.total && l.total > 0;
      const label = done ? green(pad(locale, 6)) : pad(locale, 6);
      lines.push(
        `${label} ${bar} ${l.done}/${l.total}  ` +
          `in ${fmtTokens(l.in)}  out ${fmtTokens(l.out)}  ${formatCost(l.cost)}`
      );
    }
    for (const e of this.errors.slice(-5)) {
      lines.push(red(`  ⚠ ${e}`));
    }
    return lines;
  }

  render() {
    const lines = this._lines();
    if (!this._tty) {
      // On non-TTY we only print completed-batch progress lines to avoid spam.
      return;
    }
    if (this._lastLineCount > 0) {
      process.stdout.write(`${ESC}${this._lastLineCount}A`);
    }
    for (const line of lines) {
      process.stdout.write(`${ESC}2K${line}\n`);
    }
    this._lastLineCount = lines.length;
  }

  // Non-TTY: emit a plain completion line per batch.
  logPlainBatch(locale, ns, { tokensIn, tokensOut, cost }) {
    if (this._tty) return;
    console.log(
      `done ${locale}/${ns}  in ${fmtTokens(tokensIn)} out ${fmtTokens(tokensOut)} ${formatCost(cost)}`
    );
  }
}

// --------------------------------------------------------------------------- //
// Multi-locale batch poll UI (one line per locale + header with counts).
// --------------------------------------------------------------------------- //

const MULTI_SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Joint poll dashboard: one line per locale showing its job phase + elapsed,
 * plus a header with running/succeeded/failed counts. Redrawn in place on a
 * TTY; on non-TTY emits a plain line only when a locale's phase changes.
 */
export class MultiBatchPollUI {
  constructor(locales) {
    this.startedAt = Date.now();
    this.tick = 0;
    this._tty = isTTY();
    this._lastLineCount = 0;
    // locale -> { phase, startedAt, since (ms of last phase change) }
    this.locales = new Map();
    for (const locale of locales) {
      this.locales.set(locale, { phase: "PENDING", startedAt: this.startedAt });
    }
    this._lastPlainPhase = new Map();
  }

  /** Record a locale's current phase. `note` is an optional trailing label. */
  set(locale, phase, note) {
    let l = this.locales.get(locale);
    if (!l) {
      l = { phase, startedAt: this.startedAt };
      this.locales.set(locale, l);
    }
    l.phase = phase;
    l.note = note;
  }

  _counts() {
    let running = 0,
      succeeded = 0,
      failed = 0,
      pending = 0;
    for (const l of this.locales.values()) {
      if (l.phase === "SUCCEEDED" || l.phase === "APPLIED") succeeded++;
      else if (l.phase === "FAILED" || l.phase === "CANCELLED" || l.phase === "EXPIRED")
        failed++;
      else if (l.phase === "RUNNING") running++;
      else pending++;
    }
    return { running, succeeded, failed, pending };
  }

  _lines() {
    const elapsed = fmtElapsed(Date.now() - this.startedAt);
    const { running, succeeded, failed, pending } = this._counts();
    const spin = this._tty ? MULTI_SPINNER[this.tick % MULTI_SPINNER.length] + " " : "";
    const lines = [];
    lines.push(
      `${spin}${elapsed} | ${running} running | ${succeeded} succeeded | ` +
        `${failed} failed | ${pending} pending`
    );
    for (const [locale, l] of this.locales) {
      const el = fmtElapsed(Date.now() - l.startedAt);
      // Pad the raw phase to a fixed width, then colorize (ANSI codes would
      // break pad() length math if applied first).
      let phaseCol = pad(l.phase, 10);
      if (l.phase === "SUCCEEDED" || l.phase === "APPLIED") phaseCol = green(phaseCol);
      else if (l.phase === "FAILED" || l.phase === "CANCELLED" || l.phase === "EXPIRED")
        phaseCol = red(phaseCol);
      const note = l.note ? ` ${l.note}` : "";
      lines.push(`${pad(locale, 6)} ${phaseCol} ${el}${note}`);
    }
    return lines;
  }

  /** Redraw (TTY) or flush plain phase-change lines (non-TTY). */
  render() {
    if (!this._tty) {
      for (const [locale, l] of this.locales) {
        const prev = this._lastPlainPhase.get(locale);
        const cur = l.note ? `${l.phase} ${l.note}` : l.phase;
        if (prev !== cur) {
          console.log(`${locale}  ${cur}`);
          this._lastPlainPhase.set(locale, cur);
        }
      }
      return;
    }
    this.tick++;
    const lines = this._lines();
    if (this._lastLineCount > 0) {
      process.stdout.write(`${ESC}${this._lastLineCount}A`);
    }
    for (const line of lines) {
      process.stdout.write(`${ESC}2K${line}\n`);
    }
    this._lastLineCount = lines.length;
  }
}

// --------------------------------------------------------------------------- //
// Final summary.
// --------------------------------------------------------------------------- //

/**
 * localeStats: [{ locale, translated, rejected, tokensIn, tokensOut, cost }]
 * errors: [string]
 */
export function printSummary(localeStats, errors) {
  console.log("");
  console.log(bold("Summary"));
  const header = [
    pad("locale", 8),
    padL("translated", 11),
    padL("rejected", 9),
    padL("in-tok", 10),
    padL("out-tok", 10),
    padL("cost", 10),
  ].join("  ");
  console.log(header);
  console.log("-".repeat(header.length));

  let tTr = 0,
    tRej = 0,
    tIn = 0,
    tOut = 0,
    tCost = 0;
  let anyCost = false;
  for (const s of localeStats) {
    tTr += s.translated;
    tRej += s.rejected;
    tIn += s.tokensIn;
    tOut += s.tokensOut;
    if (s.cost !== null && s.cost !== undefined) {
      tCost += s.cost;
      anyCost = true;
    }
    console.log(
      [
        pad(s.locale, 8),
        padL(s.translated, 11),
        padL(s.rejected, 9),
        padL(fmtTokens(s.tokensIn), 10),
        padL(fmtTokens(s.tokensOut), 10),
        padL(formatCost(s.cost), 10),
      ].join("  ")
    );
  }
  console.log("-".repeat(header.length));
  console.log(
    [
      pad("TOTAL", 8),
      padL(tTr, 11),
      padL(tRej, 9),
      padL(fmtTokens(tIn), 10),
      padL(fmtTokens(tOut), 10),
      padL(anyCost ? formatCost(tCost) : "—", 10),
    ].join("  ")
  );

  if (errors.length) {
    console.log("");
    console.log(red(`Errors (${errors.length}):`));
    for (const e of errors) console.log(red(`  ⚠ ${e}`));
  }
}

export { fmtTokens, fmtElapsed };
