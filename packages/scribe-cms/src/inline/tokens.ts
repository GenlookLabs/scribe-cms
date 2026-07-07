/**
 * Inline tokens: `${{...}}` markers embedded in MDX bodies. Four kinds — static
 * literals, relation URLs/slugs, asset URLs, and per-document vars. See
 * `docs/inline-tokens.md`.
 *
 * This module is the shared, dependency-light heart of the feature: a tokenizer
 * that turns a raw body into a `placeholderBody` (tokens swapped for inert
 * `%%n%%` markers) plus the parsed token list, and the fill/mask helpers used by
 * the loader, translator, validator, and studio.
 *
 * Why `%%n%%` and not `{{n}}`: `{{...}}` is a JSX expression to remark-mdx and
 * would break MDX validation of stored translated bodies. `%%n%%` is inert text.
 */

/** Opening delimiter of an inline token. */
const TOKEN_OPEN = "${{";
/** Escape sequence: `$\{{` renders as a literal `${{` and is never a token. */
const ESCAPE_SEQUENCE = "$\\{{";
const ESCAPE_RESULT = "${{";

export type InlineTokenKind = "static" | "relation" | "asset" | "var";

export interface StaticInlineToken {
  kind: "static";
  /** Verbatim literal (decoded from the token's JSON string). */
  text: string;
  /** The full `${{...}}` source span. */
  raw: string;
}

export interface RelationInlineToken {
  kind: "relation";
  targetTypeId: string;
  enSlug: string;
  /** `"href"` resolves to a link path; `"slug"` resolves to the EN slug. */
  mode: "href" | "slug";
  raw: string;
}

export interface AssetInlineToken {
  kind: "asset";
  /** Root-relative web path, e.g. `/web/path.webp`. */
  webPath: string;
  raw: string;
}

export interface VarInlineToken {
  kind: "var";
  key: string;
  raw: string;
}

export type InlineToken =
  | StaticInlineToken
  | RelationInlineToken
  | AssetInlineToken
  | VarInlineToken;

/** A `${{...}}` span that failed to parse. Reported by validation, left as-is. */
export interface MalformedInlineToken {
  raw: string;
  reason: string;
  /** Byte offset of the token's `$` in the source body. */
  index: number;
}

export interface ExtractInlineTokensResult {
  /** Body with each well-formed token replaced by `%%n%%` (1-based). */
  placeholderBody: string;
  /** Parsed well-formed tokens, in order of appearance. */
  tokens: InlineToken[];
  /** Spans that look like tokens but failed to parse. */
  malformed: MalformedInlineToken[];
}

/** The inert marker for the n-th (1-based) extracted token. */
export function placeholderMarker(n: number): string {
  return `%%${n}%%`;
}

/**
 * Find the index of the closing `}}` of a token whose content starts at
 * `start`. JSON-string aware so a static literal like `${{static:"a}}b"}}`
 * terminates at the correct `}}`. Returns the index of the first closing brace,
 * or -1 when the token is unterminated (also bails on a newline: tokens never
 * span lines).
 */
function findTokenEnd(body: string, start: number): number {
  let i = start;
  let inString = false;
  while (i < body.length) {
    const ch = body[i]!;
    if (ch === "\n") return -1;
    if (inString) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      i += 1;
      continue;
    }
    if (ch === "}" && body[i + 1] === "}") return i;
    i += 1;
  }
  return -1;
}

/** Omit that distributes over a union (unlike the built-in `Omit`). */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

type ParseResult =
  | { ok: true; token: DistributiveOmit<InlineToken, "raw"> }
  | { ok: false; reason: string };

/** Parse the inner content of a token (everything between `${{` and `}}`). */
function parseTokenInner(inner: string): ParseResult {
  const colon = inner.indexOf(":");
  if (colon === -1) {
    return { ok: false, reason: `missing kind separator ":"` };
  }
  const kind = inner.slice(0, colon);
  const rest = inner.slice(colon + 1);

  switch (kind) {
    case "static": {
      let text: unknown;
      try {
        text = JSON.parse(rest);
      } catch {
        return { ok: false, reason: `static value is not a valid JSON string` };
      }
      if (typeof text !== "string") {
        return { ok: false, reason: `static value must be a JSON string` };
      }
      return { ok: true, token: { kind: "static", text } };
    }
    case "relation": {
      // Slugs cannot contain ":" so splitting is unambiguous.
      const parts = rest.split(":");
      if (parts.length !== 3) {
        return {
          ok: false,
          reason: `relation must be relation:<typeId>:<enSlug>:href or relation:<typeId>:<enSlug>:slug`,
        };
      }
      const [targetTypeId, enSlug, mode] = parts;
      if (!targetTypeId || !enSlug) {
        return { ok: false, reason: `relation is missing a typeId or enSlug` };
      }
      if (mode !== "href" && mode !== "slug") {
        return { ok: false, reason: `relation mode must be "href" or "slug" (got "${mode}")` };
      }
      return {
        ok: true,
        token: {
          kind: "relation",
          targetTypeId,
          enSlug,
          mode,
        },
      };
    }
    case "asset": {
      if (!rest.startsWith("/")) {
        return { ok: false, reason: `asset path must start with "/" (got "${rest}")` };
      }
      return { ok: true, token: { kind: "asset", webPath: rest } };
    }
    case "var": {
      if (!rest) return { ok: false, reason: `var is missing a key` };
      return { ok: true, token: { kind: "var", key: rest } };
    }
    default:
      return { ok: false, reason: `unknown token kind "${kind}"` };
  }
}

/**
 * Replace every well-formed token with an inert `%%n%%` marker and return the
 * parsed token list. Malformed spans are left verbatim (validation reports them)
 * and do NOT consume a marker index. Escape sequences (`$\{{`) are not tokens
 * and pass through untouched — so a body with zero tokens yields
 * `placeholderBody === body` byte-for-byte.
 */
export function extractInlineTokens(body: string): ExtractInlineTokensResult {
  const tokens: InlineToken[] = [];
  const malformed: MalformedInlineToken[] = [];
  let out = "";
  let i = 0;

  while (i < body.length) {
    const open = body.indexOf(TOKEN_OPEN, i);
    if (open === -1) {
      out += body.slice(i);
      break;
    }
    out += body.slice(i, open);

    const contentStart = open + TOKEN_OPEN.length;
    const end = findTokenEnd(body, contentStart);
    if (end === -1) {
      // Unterminated: leave the rest verbatim; report it.
      malformed.push({
        raw: body.slice(open),
        reason: `unterminated token (missing "}}")`,
        index: open,
      });
      out += body.slice(open);
      break;
    }

    const raw = body.slice(open, end + 2);
    const inner = body.slice(contentStart, end);
    const parsed = parseTokenInner(inner);
    if (parsed.ok) {
      tokens.push({ ...parsed.token, raw } as InlineToken);
      out += placeholderMarker(tokens.length);
    } else {
      malformed.push({ raw, reason: parsed.reason, index: open });
      out += raw;
    }
    i = end + 2;
  }

  return { placeholderBody: out, tokens, malformed };
}

/**
 * Fill `%%n%%` markers with resolved values (1-based). A marker with no
 * corresponding value (a stale translation whose EN body lost tokens) is left
 * verbatim rather than blanked, so no meaningful text is silently dropped.
 */
export function fillPlaceholders(body: string, resolvedValues: string[]): string {
  return body.replace(/%%(\d+)%%/g, (match, n: string) => {
    const idx = Number(n) - 1;
    return idx >= 0 && idx < resolvedValues.length ? resolvedValues[idx]! : match;
  });
}

/** Convert `$\{{` escape sequences back to a literal `${{`. Render-time only. */
export function unescapeInlineTokens(body: string): string {
  return body.split(ESCAPE_SEQUENCE).join(ESCAPE_RESULT);
}

/**
 * Count the markers `%%1%%..%%N%%` in a body. Used by the post-receive
 * verification: each must appear exactly once in a translated body.
 */
export function countMarkerOccurrences(body: string, n: number): number {
  return body.split(placeholderMarker(n)).length - 1;
}

/**
 * Walk a body replacing every token span (valid OR malformed) and every escape
 * sequence via the provided callbacks. Used where the raw `${{` / `$\{{` braces
 * must never reach a downstream MDX parser or preview renderer.
 */
export function replaceInlineSpans(
  body: string,
  opts: {
    token: (raw: string, inner: string) => string;
    escape: () => string;
  },
): string {
  let out = "";
  let i = 0;
  while (i < body.length) {
    if (body.startsWith(ESCAPE_SEQUENCE, i)) {
      out += opts.escape();
      i += ESCAPE_SEQUENCE.length;
      continue;
    }
    if (body.startsWith(TOKEN_OPEN, i)) {
      const end = findTokenEnd(body, i + TOKEN_OPEN.length);
      if (end !== -1) {
        const raw = body.slice(i, end + 2);
        const inner = body.slice(i + TOKEN_OPEN.length, end);
        out += opts.token(raw, inner);
        i = end + 2;
        continue;
      }
    }
    out += body[i]!;
    i += 1;
  }
  return out;
}

/**
 * Neutralize inline tokens and escapes so a body can be handed to remark-mdx for
 * a structural parse check without the `${{`/`{{` braces producing false MDX
 * errors. Local to validation/preview: never used for hashing or storage.
 */
export function maskInlineTokensForMdx(body: string): string {
  return replaceInlineSpans(body, {
    token: () => "inline",
    escape: () => "$",
  });
}
