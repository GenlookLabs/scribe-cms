import type {
  TranslatePageResult,
  TranslateProgressEvent,
  TranslateWorklistTotals,
} from "../src/translate/page-translator.js";
import { formatTokenCount, formatUsd } from "../src/translate/gemini-pricing.js";

const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;
const green = (text: string) => `\x1b[32m${text}\x1b[0m`;
const yellow = (text: string) => `\x1b[33m${text}\x1b[0m`;
const red = (text: string) => `\x1b[31m${text}\x1b[0m`;
const cyan = (text: string) => `\x1b[36m${text}\x1b[0m`;

function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

function progressBar(ratio: number, width = 28): string {
  const clamped = Math.max(0, Math.min(1, ratio));
  const filled = Math.round(clamped * width);
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

function labelForResult(result: TranslatePageResult): string {
  return `${result.contentType}/${result.enSlug}@${result.locale}`;
}

function statusForResult(result: TranslatePageResult, dryRun: boolean): string {
  if (result.failed) return red("failed");
  if (result.skipped) return dim("skipped");
  if (dryRun) return yellow("would translate");
  return green("translated");
}

function slugAdjustedMessage(result: TranslatePageResult): string | undefined {
  if (!result.slugAdjusted) return undefined;
  const { from, to, matchedCode } = result.slugAdjusted;
  return yellow(
    `slug adjusted: "${from}" → "${to}" (stripped -${matchedCode})`,
  );
}

function detailForResult(result: TranslatePageResult): string {
  const parts: string[] = [];
  const slugMsg = slugAdjustedMessage(result);
  if (slugMsg) parts.push(slugMsg);
  if (result.durationMs !== undefined) parts.push(`${(result.durationMs / 1000).toFixed(1)}s`);
  if (result.usage) {
    parts.push(`${formatTokenCount(result.usage.inputTokens)} in`);
    parts.push(`${formatTokenCount(result.usage.outputTokens)} out`);
  }
  if (result.estimatedCostUsd !== undefined) parts.push(formatUsd(result.estimatedCostUsd));
  if (result.error) parts.push(red(result.error));
  return parts.length > 0 ? dim(parts.join(" · ")) : "";
}

function formatSummaryLine(totals: TranslateWorklistTotals, dryRun: boolean): string {
  const action = dryRun ? "Would translate" : "Translated";
  const parts = [
    `${action} ${totals.translated}`,
    `skipped ${totals.skipped}`,
  ];
  if (totals.failed > 0) parts.push(red(`failed ${totals.failed}`));
  parts.push(`${formatTokenCount(totals.inputTokens)} in / ${formatTokenCount(totals.outputTokens)} out`);
  parts.push(`${formatUsd(totals.estimatedCostUsd)} est.`);
  parts.push(`${(totals.durationMs / 1000).toFixed(1)}s`);
  return parts.join(" · ");
}

export interface TranslateProgressReporter {
  onEvent: (event: TranslateProgressEvent) => void;
  finish: () => void;
}

export function createTranslateProgressReporter(options: {
  enabled?: boolean;
  dryRun?: boolean;
  recentLimit?: number;
} = {}): TranslateProgressReporter {
  const enabled = options.enabled ?? isInteractive();
  const dryRun = Boolean(options.dryRun);
  const recentLimit = options.recentLimit ?? 6;

  if (!enabled) {
    return {
      onEvent(event) {
        if (event.type === "item-done") {
          const label = labelForResult(event.result);
          const status = statusForResult(event.result, dryRun);
          const detail = detailForResult(event.result);
          console.log(`${label}: ${status}${detail ? ` (${detail.replace(/\x1b\[[0-9;]*m/g, "")})` : ""}`);
          const slugMsg = slugAdjustedMessage(event.result);
          if (slugMsg) {
            console.log(`[warning] ${labelForResult(event.result)} ${slugMsg.replace(/\x1b\[[0-9;]*m/g, "")}`);
          }
          if (event.result.failed && event.result.error) {
            console.error(event.result.error);
          }
          return;
        }
        if (event.type === "done") {
          console.log(formatSummaryLine(event.totals, dryRun));
        }
      },
      finish() {},
    };
  }

  let total = 0;
  let concurrency = 1;
  let model: string | undefined;
  let done = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let estimatedCostUsd = 0;
  let active: string[] = [];
  const recent: TranslatePageResult[] = [];
  let renderedLines = 0;
  let cursorHidden = false;

  function hideCursor(): void {
    if (!cursorHidden) {
      process.stdout.write("\x1b[?25l");
      cursorHidden = true;
    }
  }

  function showCursor(): void {
    if (cursorHidden) {
      process.stdout.write("\x1b[?25h");
      cursorHidden = false;
    }
  }

  function render(): void {
    hideCursor();
    if (renderedLines > 0) {
      process.stdout.write(`\x1b[${renderedLines}A`);
    }

    const lines: string[] = [];
    const title = dryRun ? "Dry run" : "Translating";
    lines.push(cyan(`${title} ${done}/${total}`) + dim(` · ${concurrency} parallel`) + (model ? dim(` · ${model}`) : ""));
    lines.push(progressBar(total === 0 ? 0 : done / total) + dim(`  ${Math.round(total === 0 ? 0 : (done / total) * 100)}%`));
    lines.push(
      dim("Tokens ") +
        `${formatTokenCount(inputTokens)} in · ${formatTokenCount(outputTokens)} out` +
        dim(" · Cost ") +
        formatUsd(estimatedCostUsd) +
        dim(" est."),
    );

    if (active.length > 0) {
      lines.push(dim("Active ") + active.slice(0, 3).join(", ") + (active.length > 3 ? dim(` +${active.length - 3}`) : ""));
    } else if (done < total) {
      lines.push(dim("Active ") + "starting…");
    } else {
      lines.push("");
    }

    lines.push("");
    if (recent.length === 0) {
      lines.push(dim("Waiting for first page…"));
    } else {
      for (const result of recent) {
        const detail = detailForResult(result);
        lines.push(`${statusForResult(result, dryRun)} ${labelForResult(result)}${detail ? ` ${detail}` : ""}`);
      }
    }

    for (const line of lines) {
      process.stdout.write("\x1b[2K" + line + "\n");
    }
    renderedLines = lines.length;
  }

  return {
    onEvent(event) {
      switch (event.type) {
        case "start":
          total = event.total;
          concurrency = event.concurrency;
          model = event.model;
          render();
          break;
        case "item-start":
          active = event.active;
          render();
          break;
        case "item-done": {
          done += 1;
          active = active.filter((label) => label !== labelForResult(event.result));
          inputTokens += event.result.usage?.inputTokens ?? 0;
          outputTokens += event.result.usage?.outputTokens ?? 0;
          estimatedCostUsd += event.result.estimatedCostUsd ?? 0;
          recent.unshift(event.result);
          recent.splice(recentLimit);
          render();
          break;
        }
        case "done":
          showCursor();
          if (renderedLines > 0) {
            process.stdout.write(`\x1b[${renderedLines}A`);
          }
          process.stdout.write("\x1b[2K" + green("Done") + " · " + formatSummaryLine(event.totals, dryRun) + "\n");
          renderedLines = 0;
          for (const result of event.results.filter((entry) => entry.failed)) {
            process.stdout.write("\x1b[2K" + red(`${labelForResult(result)}: ${result.error ?? "failed"}`) + "\n");
          }
          for (const result of event.results.filter((entry) => entry.slugAdjusted)) {
            const slugMsg = slugAdjustedMessage(result);
            if (slugMsg) {
              process.stdout.write(
                "\x1b[2K" + yellow(`[warning] ${labelForResult(result)} ${slugMsg.replace(/\x1b\[[0-9;]*m/g, "")}`) + "\n",
              );
            }
          }
          break;
      }
    },
    finish() {
      showCursor();
    },
  };
}
