import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ValidateIssue } from "../src/validate/validate-project.js";
import { validationBadge } from "./content-views.js";

function issue(over: Partial<ValidateIssue>): ValidateIssue {
  return { level: "error", message: "an issue", ...over };
}

describe("validationBadge tooltip", () => {
  it("returns empty string for no issues", () => {
    assert.equal(validationBadge(undefined), "");
    assert.equal(validationBadge([]), "");
  });

  it("renders count chips wrapped in a vtip with a panel", () => {
    const html = validationBadge([
      issue({ level: "error" }),
      issue({ level: "error" }),
      issue({ level: "error" }),
      issue({ level: "warning" }),
      issue({ level: "warning" }),
    ]);
    assert.match(html, /<span class="vtip" tabindex="0">/);
    assert.match(html, /<span class="vbadge err">3✕<\/span>/);
    assert.match(html, /<span class="vbadge warn">2!<\/span>/);
    assert.match(html, /<div class="vtip-panel">/);
    assert.match(html, /<div class="vrow">/);
  });

  it("drops the old title attributes", () => {
    const html = validationBadge([issue({ level: "error" }), issue({ level: "warning" })]);
    assert.doesNotMatch(html, /title=/);
  });

  it("includes enSlug, locale, and field (muted mono) when present", () => {
    const html = validationBadge([
      issue({ level: "error", enSlug: "denim", locale: "fr", field: "title", message: "bad" }),
    ]);
    assert.match(html, /<span class="vmeta">denim<\/span>/);
    assert.match(html, /<span class="vmeta">fr<\/span>/);
    assert.match(html, /<span class="vmeta">title<\/span>/);
  });

  it("sorts errors before warnings in the panel", () => {
    const html = validationBadge([
      issue({ level: "warning", message: "warn-msg" }),
      issue({ level: "error", message: "err-msg" }),
    ]);
    assert.ok(html.indexOf("err-msg") < html.indexOf("warn-msg"), "error row should precede warning row");
  });

  it("caps the panel at 10 rows with a +N more issues row", () => {
    const issues = Array.from({ length: 12 }, (_, i) => issue({ level: "error", message: `m${i}` }));
    const html = validationBadge(issues);
    const rowCount = (html.match(/<div class="vrow">/g) ?? []).length;
    assert.equal(rowCount, 10);
    assert.match(html, /<div class="vrow more">\+2 more issues<\/div>/);
  });

  it("truncates long messages to 140 chars with an ellipsis", () => {
    const long = "x".repeat(200);
    const html = validationBadge([issue({ level: "error", message: long })]);
    assert.match(html, /x{140}…/);
    assert.doesNotMatch(html, /x{141}/);
  });
});
