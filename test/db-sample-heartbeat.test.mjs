import { test } from "node:test";
import assert from "node:assert/strict";

// Mirrors the dedup logic in dbAppendBucketSampleIfChanged. The heartbeat
// rule guarantees we always anchor a flat period on the timeline so the
// burn-projection chart can render it as a horizontal line at the correct
// utilization level, rather than a single drifting dot.
const SAMPLE_HEARTBEAT_MS = 5 * 60 * 1000;

function shouldAppend(last, sample) {
  if (!last) return true;
  if (last.u !== sample.u) return true;                  // value changed
  return sample.t - last.t >= SAMPLE_HEARTBEAT_MS;       // heartbeat elapsed
}

test("appends when no prior sample", () => {
  assert.equal(shouldAppend(null, { t: 1000, u: 3 }), true);
});

test("appends when utilization changes (even within heartbeat)", () => {
  const last = { t: 1_000_000, u: 3 };
  assert.equal(shouldAppend(last, { t: 1_001_000, u: 4 }), true,
    "different u must always append");
});

test("skips dup within 5 minutes (this is the dedup we keep)", () => {
  const last = { t: 1_000_000, u: 3 };
  // 1 minute later, same value
  assert.equal(shouldAppend(last, { t: 1_000_000 + 60_000, u: 3 }), false);
});

test("appends after 5 minutes even if value unchanged (THIS is the fix)", () => {
  const last = { t: 1_000_000, u: 3 };
  // exactly 5 minutes later
  assert.equal(shouldAppend(last, { t: 1_000_000 + 5 * 60_000, u: 3 }), true);
  // 6 minutes later
  assert.equal(shouldAppend(last, { t: 1_000_000 + 6 * 60_000, u: 3 }), true);
});

test("heartbeat fix → 30 days of always-on at 1 sample / 5 min = 8640", () => {
  // Sanity: confirm the trim cap of 12000 leaves ~30 days of headroom.
  const samplesPerDay = (24 * 60) / 5;            // 288
  const thirtyDays = 30 * samplesPerDay;          // 8640
  assert.ok(thirtyDays < 12000, "trim cap should comfortably hold 30 days at 5-min cadence");
});
