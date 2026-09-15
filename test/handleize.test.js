import { test } from "node:test";
import assert from "node:assert/strict";
import { handleize } from "../src/handleize.js";

// Baseline cases. IMPORTANT: replace / extend these with ~20 REAL raw-tag -> live-URL
// pairs from the PEP storefront before trusting handleize at scale.
const cases = [
  ["High Heels", "high-heels"],
  ["Ankle Boots", "ankle-boots"],
  ["Stilettos", "stilettos"],
  ["Denim Jacket", "denim-jacket"],
  ["  Trailing Space  ", "trailing-space"],
  ["Café", "cafe"],
  ["A & B", "a-b"],
  ["100% Cotton", "100-cotton"],
];

test("handleize matches Shopify-style output", () => {
  for (const [input, expected] of cases) {
    assert.equal(handleize(input), expected, `handleize(${JSON.stringify(input)})`);
  }
});
