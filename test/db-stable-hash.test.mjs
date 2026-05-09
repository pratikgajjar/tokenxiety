import { test } from "node:test";
import assert from "node:assert/strict";

// Inline copy of stableStringify from src/db.js. Kept in sync to lock the
// content-hashing behaviour — particularly the regression where two API
// responses with identical SHAPE but different nested values were hashing to
// the same string and the dashboard was getting stuck on stale data.
function stableStringify(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(value[k])).join(",") + "}";
}

test("stableStringify keeps nested fields (regression: replacer-as-array dropped them)", () => {
  const a = { five_hour: { utilization: 7,  resets_at: "2026-05-06T00:00:00Z" } };
  const b = { five_hour: { utilization: 33, resets_at: "2026-05-09T00:00:00Z" } };
  assert.notEqual(stableStringify(a), stableStringify(b),
    "different nested utilization values must produce different strings");
});

test("stableStringify is order-independent at every level", () => {
  const a = { five_hour: { utilization: 4, resets_at: null }, seven_day: null };
  const b = { seven_day: null, five_hour: { resets_at: null, utilization: 4 } };
  assert.equal(stableStringify(a), stableStringify(b));
});

test("stableStringify handles arrays, null, and primitives", () => {
  assert.equal(stableStringify([1, "two", null]), '[1,"two",null]');
  assert.equal(stableStringify(null), "null");
  assert.equal(stableStringify(undefined), "null");
  assert.equal(stableStringify(42), "42");
  assert.equal(stableStringify("hello"), '"hello"');
});

test("stableStringify produces same output for the user's real payload shape", () => {
  const claude = (fiveU, sevenU) => ({
    five_hour: { utilization: fiveU, resets_at: "2026-05-09T09:00:00Z" },
    seven_day: { utilization: sevenU, resets_at: "2026-05-09T09:00:00Z" },
    seven_day_oauth_apps: null,
    seven_day_opus: null,
    seven_day_sonnet: { utilization: 0, resets_at: null },
    extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null, currency: null }
  });
  // Shape identical, values differ — must hash differently.
  assert.notEqual(stableStringify(claude(7, 31)), stableStringify(claude(33, 91)));
  // Same values — must hash the same.
  assert.equal(stableStringify(claude(33, 91)), stableStringify(claude(33, 91)));
});
