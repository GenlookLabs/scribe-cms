import assert from "node:assert/strict";
import { test } from "node:test";
import { renderDeletionPlanText } from "./render-text.js";
import type { DeletionPlan } from "./plan.js";

const plan: DeletionPlan = {
  roots: [{ typeId: "model", enSlug: "alice", title: "Alice" }],
  cascades: [{ typeId: "example", enSlug: "ex1", via: "model=alice" }],
  detaches: [{ typeId: "vertical", enSlug: "v1", fieldPath: "examples", removedSlug: "ex1" }],
  blocked: [],
  assets: [
    { path: "/m/alice.webp", ownerTypeId: "model", ownerEnSlug: "alice", action: "delete" },
    { path: "/shared.webp", ownerTypeId: "example", ownerEnSlug: "ex1", action: "keep", reason: "shared" },
  ],
  store: [
    { typeId: "model", enSlug: "alice", translations: 3, snapshots: 1 },
    { typeId: "example", enSlug: "ex1", translations: 2, snapshots: 1 },
  ],
};

test("render-text groups the plan and reports totals", () => {
  const out = renderDeletionPlanText(plan);
  assert.match(out, /Cascades \(1\)/);
  assert.match(out, /example\/ex1/);
  assert.match(out, /Detaches \(1\)/);
  assert.match(out, /drops "ex1"/);
  assert.match(out, /Assets \(1 to delete, 1 kept\)/);
  assert.match(out, /Store rows: 5 translation\(s\), 2 snapshot\(s\)/);
});

test("render-text surfaces blockers", () => {
  const blockedPlan: DeletionPlan = {
    ...plan,
    blocked: [{ typeId: "collection", enSlug: "c1", fieldPath: "hero", reason: "restrict" }],
  };
  const out = renderDeletionPlanText(blockedPlan);
  assert.match(out, /Blockers \(1\)/);
  assert.match(out, /collection\/c1/);
});

test("CLI plan output contains no em dashes", () => {
  assert.equal(renderDeletionPlanText(plan).includes("—"), false);
});
