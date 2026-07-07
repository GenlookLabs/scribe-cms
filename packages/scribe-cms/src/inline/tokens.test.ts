import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computePageEnHash } from "../hash/page-hash.js";
import { verifyInlineMarkers } from "../translate/translate-core.js";
import {
  countMarkerOccurrences,
  extractInlineTokens,
  fillPlaceholders,
  maskInlineTokensForMdx,
  placeholderMarker,
  replaceInlineSpans,
  unescapeInlineTokens,
  type InlineToken,
} from "./tokens.js";

describe("extractInlineTokens", () => {
  it("extracts each kind and replaces with ordered markers", () => {
    const body =
      'A ${{static:"hello"}} B ${{relation:blog:my-post:href}} C ${{relation:blog:my-post:slug}} ' +
      "D ${{asset:/img/a.webp}} E ${{var:cta}} F";
    const { placeholderBody, tokens, malformed } = extractInlineTokens(body);
    assert.equal(malformed.length, 0);
    assert.equal(
      placeholderBody,
      "A %%1%% B %%2%% C %%3%% D %%4%% E %%5%% F",
    );
    assert.deepEqual(
      tokens.map((t) => t.kind),
      ["static", "relation", "relation", "asset", "var"],
    );
    const [s, rHref, rSlug, a, v] = tokens as [
      InlineToken,
      InlineToken,
      InlineToken,
      InlineToken,
      InlineToken,
    ];
    assert.equal(s.kind === "static" && s.text, "hello");
    assert.ok(rHref.kind === "relation" && rHref.mode === "href" && rHref.enSlug === "my-post");
    assert.ok(rSlug.kind === "relation" && rSlug.mode === "slug");
    assert.equal(a.kind === "asset" && a.webPath, "/img/a.webp");
    assert.equal(v.kind === "var" && v.key, "cta");
  });

  it("handles a static value containing }} and quotes", () => {
    const body = 'x ${{static:"a }} b \\" c"}} y';
    const { tokens } = extractInlineTokens(body);
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0]!.kind === "static" && tokens[0]!.text, 'a }} b " c');
  });

  it("leaves the escape sequence $\\{{ as a non-token", () => {
    const body = 'before $\\{{static:"x"}} after';
    const { placeholderBody, tokens } = extractInlineTokens(body);
    assert.equal(tokens.length, 0);
    assert.equal(placeholderBody, body); // untouched
    assert.equal(unescapeInlineTokens(placeholderBody), 'before ${{static:"x"}} after');
  });

  it("reports malformed tokens and leaves them verbatim", () => {
    const cases: Array<[string, RegExp]> = [
      ['${{static:not-json}}', /JSON string/],
      ['${{relation:onlyone}}', /relation:/],
      ['${{relation:blog:post}}', /relation:/],
      ['${{asset:no-leading-slash}}', /must start with/],
      ['${{var:}}', /missing a key/],
      ['${{weird:x}}', /unknown token kind/],
      ['${{static:"x"', /unterminated/],
    ];
    for (const [body, re] of cases) {
      const { tokens, malformed, placeholderBody } = extractInlineTokens(body);
      assert.equal(tokens.length, 0, `no valid token for ${body}`);
      assert.equal(malformed.length, 1, `one malformed for ${body}`);
      assert.match(malformed[0]!.reason, re);
      assert.ok(placeholderBody.includes("${{"), `malformed left verbatim for ${body}`);
    }
  });

  it("preserves order and numbering across mixed valid/malformed", () => {
    const body = "${{var:a}} ${{bad}} ${{var:b}}";
    const { placeholderBody, tokens, malformed } = extractInlineTokens(body);
    assert.equal(placeholderBody, "%%1%% ${{bad}} %%2%%");
    assert.equal(tokens.length, 2);
    assert.equal(malformed.length, 1);
  });
});

describe("fillPlaceholders", () => {
  it("fills markers by index and leaves unmatched markers", () => {
    assert.equal(fillPlaceholders("a %%1%% b %%2%%", ["X", "Y"]), "a X b Y");
    assert.equal(fillPlaceholders("a %%2%%", ["only"]), "a %%2%%");
  });

  it("does not re-scan replacement values", () => {
    assert.equal(fillPlaceholders("%%1%%", ["%%1%%"]), "%%1%%");
  });
});

describe("countMarkerOccurrences", () => {
  it("counts marker occurrences", () => {
    assert.equal(countMarkerOccurrences("%%1%% and %%1%%", 1), 2);
    assert.equal(countMarkerOccurrences("none", 3), 0);
  });
});

describe("maskInlineTokensForMdx / replaceInlineSpans", () => {
  it("removes all brace syntax so MDX never sees {{", () => {
    const masked = maskInlineTokensForMdx('a ${{static:"x"}} b $\\{{ c ${{bad}}');
    assert.equal(masked.includes("{{"), false);
  });

  it("replaceInlineSpans covers valid, malformed and escapes", () => {
    const out = replaceInlineSpans('${{var:x}} $\\{{ ${{bad}}', {
      token: () => "T",
      escape: () => "E",
    });
    assert.equal(out, "T E T");
  });
});

describe("hash invariants", () => {
  const fm = { title: "Hi" };
  const hashOf = (body: string) =>
    computePageEnHash(fm, extractInlineTokens(body).placeholderBody);

  it("changing a token VALUE does not change the hash", () => {
    const a = hashOf('Buy ${{relation:blog:old:href}} now ${{var:x}} ${{asset:/a.webp}} ${{static:"A"}}');
    const b = hashOf('Buy ${{relation:blog:new:href}} now ${{var:y}} ${{asset:/b.webp}} ${{static:"B"}}');
    assert.equal(a, b);
  });

  it("adding, removing or moving tokens changes the hash", () => {
    const base = hashOf("alpha ${{var:a}} beta ${{var:b}} gamma");
    const added = hashOf("alpha ${{var:a}} beta ${{var:b}} gamma ${{var:c}}");
    const removed = hashOf("alpha ${{var:a}} beta gamma");
    // Moving a token to a different textual position shifts the markers.
    const moved = hashOf("alpha ${{var:a}} ${{var:b}} beta gamma");
    assert.notEqual(base, added);
    assert.notEqual(base, removed);
    assert.notEqual(base, moved);
  });

  it("swapping two in-place token identities is a value change (hash stable)", () => {
    // Same surrounding text, tokens swapped: the placeholder body is identical,
    // so this reads as a value-only edit and does not restale.
    const a = hashOf("one ${{var:a}} two ${{var:b}}");
    const b = hashOf("one ${{var:b}} two ${{var:a}}");
    assert.equal(a, b);
  });

  it("a tokenless body hashes byte-identically to the raw body", () => {
    const body = "# Title\n\nPlain paragraph with no tokens.\n";
    const { placeholderBody } = extractInlineTokens(body);
    assert.equal(placeholderBody, body);
    assert.equal(computePageEnHash(fm, placeholderBody), computePageEnHash(fm, body));
  });
});

describe("verifyInlineMarkers", () => {
  const en = "a ${{var:x}} b ${{var:y}}";

  it("passes when every marker appears exactly once", () => {
    assert.doesNotThrow(() => verifyInlineMarkers(en, "aa %%1%% bb %%2%%"));
  });

  it("passes for a tokenless EN body regardless of the translation", () => {
    assert.doesNotThrow(() => verifyInlineMarkers("no tokens here", "anything"));
  });

  it("fails when a marker is missing", () => {
    assert.throws(() => verifyInlineMarkers(en, "aa %%1%% bb"), /missing %%2%%/);
  });

  it("fails when a marker is duplicated", () => {
    assert.throws(
      () => verifyInlineMarkers(en, "%%1%% %%1%% %%2%%"),
      /duplicated %%1%%/,
    );
  });
});

describe("placeholderMarker", () => {
  it("formats 1-based markers", () => {
    assert.equal(placeholderMarker(1), "%%1%%");
    assert.equal(placeholderMarker(42), "%%42%%");
  });
});
