import { test } from "node:test";
import assert from "node:assert/strict";

import { extractClaudeQuota, extractCodexQuota } from "../src/extractors.js";

test("extractClaudeQuota maps utilization buckets (percent scale)", () => {
  const payload = {
    five_hour: { utilization: 4.0, resets_at: "2026-05-03T07:30:00.000Z" },
    seven_day: { utilization: 0.0, resets_at: "2026-05-09T09:00:00.000Z" },
    seven_day_oauth_apps: null,
    seven_day_opus: null,
    seven_day_sonnet: { utilization: 0.0, resets_at: null },
    seven_day_cowork: null,
    seven_day_omelette: { utilization: 0.0, resets_at: null },
    tangelo: null,
    iguana_necktie: null,
    omelette_promotional: null,
    extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null, currency: null }
  };

  const quota = extractClaudeQuota(payload);
  assert.equal(quota.providerId, "claude");
  assert.equal(quota.status, "ready");
  assert.equal(quota.source, "api");
  assert.equal(quota.unit, "%");
  assert.equal(quota.limit, 100);
  assert.equal(quota.used, 4);
  assert.equal(quota.remaining, 96);
  assert.equal(quota.resetAt, "2026-05-03T07:30:00.000Z");
  assert.equal(quota.buckets.length, 4, "four non-null windows");
  const fiveHour = quota.buckets.find((bucket) => bucket.key === "five_hour");
  assert.equal(fiveHour.utilization, 4);
  assert.equal(fiveHour.remainingPercent, 96);
});

test("extractClaudeQuota returns null for empty payload", () => {
  assert.equal(extractClaudeQuota({}), null);
});

test("extractClaudeQuota clamps utilization above 100", () => {
  const quota = extractClaudeQuota({ five_hour: { utilization: 250, resets_at: null } });
  assert.equal(quota.used, 100);
  assert.equal(quota.remaining, 0);
  assert.equal(quota.buckets[0].utilization, 100);
});

test("extractCodexQuota maps wham/usage payload (root + additional + plan)", () => {
  const payload = {
    user_id: "user-1",
    email: "tester@example.com",
    plan_type: "prolite",
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: { used_percent: 2, limit_window_seconds: 18_000, reset_after_seconds: 17_379, reset_at: 1_777_793_386 },
      secondary_window: { used_percent: 28, limit_window_seconds: 604_800, reset_after_seconds: 228_515, reset_at: 1_778_004_522 }
    },
    code_review_rate_limit: null,
    additional_rate_limits: [
      {
        limit_name: "GPT-5.3-Codex-Spark",
        metered_feature: "codex_bengalfox",
        rate_limit: {
          primary_window: { used_percent: 0, limit_window_seconds: 18_000, reset_after_seconds: 18_000, reset_at: 1_777_794_008 },
          secondary_window: { used_percent: 0, limit_window_seconds: 604_800, reset_after_seconds: 604_800, reset_at: 1_778_380_808 }
        }
      }
    ],
    credits: { has_credits: false, unlimited: false, overage_limit_reached: false, balance: "0" },
    spend_control: { reached: false, individual_limit: null }
  };

  const quota = extractCodexQuota(payload);
  assert.equal(quota.providerId, "codex");
  assert.equal(quota.status, "ready");
  assert.equal(quota.source, "api");
  assert.equal(quota.unit, "%");
  assert.equal(quota.plan, "Prolite");
  assert.equal(quota.used, 28, "max utilization across windows");
  assert.equal(quota.remaining, 72);
  assert.equal(quota.limit, 100);
  assert.equal(quota.buckets.length, 4, "two root + two additional rate-limit windows");

  const sevenDay = quota.buckets.find((bucket) => bucket.label === "Codex (7d)");
  assert.ok(sevenDay, "labels root window with duration");
  assert.equal(sevenDay.utilization, 28);
  assert.equal(sevenDay.resetsAt, new Date(1_778_004_522 * 1000).toISOString());

  const sparkPrimary = quota.buckets.find((bucket) => bucket.label === "GPT-5.3-Codex-Spark (5h)");
  assert.ok(sparkPrimary, "additional rate limits surface with their friendly name");

  assert.equal(quota.account?.email, "tester@example.com");
  assert.equal(quota.account?.userId, "user-1");
});

test("extractCodexQuota returns null when no rate limits", () => {
  assert.equal(extractCodexQuota({ user_id: "user-1" }), null);
});
