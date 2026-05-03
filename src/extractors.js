"use strict";

// Names mirror what Anthropic's claude.ai/settings/usage page shows.
const CLAUDE_BUCKET_LABELS = {
  five_hour: "Current session",
  seven_day: "All models",
  seven_day_sonnet: "Sonnet only",
  seven_day_opus: "Opus only",
  seven_day_omelette: "Claude Design",
  seven_day_cowork: "Co-work",
  seven_day_oauth_apps: "OAuth apps",
  tangelo: "Tangelo",
  iguana_necktie: "Iguana Necktie",
  omelette_promotional: "Claude Design promo",
  extra_usage: "Top-up credits"
};

const CLAUDE_BUCKET_ORDER = [
  "five_hour",
  "seven_day",
  "seven_day_sonnet",
  "seven_day_opus",
  "seven_day_omelette",
  "seven_day_cowork",
  "seven_day_oauth_apps",
  "extra_usage",
  "tangelo",
  "iguana_necktie",
  "omelette_promotional"
];

export function extractClaudeQuota(payload, account) {
  if (!payload || typeof payload !== "object") return null;

  const buckets = [];
  for (const [key, value] of Object.entries(payload)) {
    if (value === null || value === undefined) continue;
    if (key === "extra_usage") {
      const extra = parseExtraUsage(key, value);
      if (extra) buckets.push(extra);
      continue;
    }
    const bucket = parseUtilizationBucket(key, value);
    if (bucket) buckets.push(bucket);
  }
  if (buckets.length === 0) return null;

  buckets.sort((a, b) => orderIndex(a.key) - orderIndex(b.key));

  const sized = buckets.filter((bucket) => Number.isFinite(bucket.utilization));
  const maxUtilization = sized.length === 0 ? 0 : Math.max(...sized.map((bucket) => bucket.utilization));
  const used = roundTo(maxUtilization, 1);
  const remaining = roundTo(Math.max(0, 100 - maxUtilization), 1);
  const constraining = sized.find((bucket) => bucket.utilization === maxUtilization);
  const resetAt = constraining?.resetsAt ?? earliestReset(sized);

  return {
    providerId: "claude",
    status: "ready",
    source: "api",
    label: "Claude",
    plan: account?.plan ?? null,
    remaining,
    limit: 100,
    used,
    resetAt,
    detail: constraining ? `Most used: ${constraining.label}` : "Claude usage detected.",
    confidence: 1,
    observedAt: new Date().toISOString(),
    unit: "%",
    buckets,
    account: account ? cleanAccount(account) : null
  };
}

export function extractCodexQuota(payload) {
  if (!payload || typeof payload !== "object") return null;

  const buckets = [];

  if (payload.rate_limit) {
    addRateLimitWindows(buckets, "codex", "Codex", payload.rate_limit);
  }
  if (Array.isArray(payload.additional_rate_limits)) {
    for (const item of payload.additional_rate_limits) {
      if (!item?.rate_limit) continue;
      const baseLabel = item.limit_name ?? item.metered_feature ?? "Additional";
      const baseKey = slugify(item.metered_feature ?? item.limit_name ?? "additional");
      addRateLimitWindows(buckets, baseKey, baseLabel, item.rate_limit);
    }
  }
  if (payload.code_review_rate_limit) {
    addRateLimitWindows(buckets, "code_review", "Code review", payload.code_review_rate_limit);
  }

  const credits = parseCodexCredits(payload.credits);
  if (credits) buckets.push(credits);

  if (buckets.length === 0) return null;

  const sized = buckets.filter((bucket) => Number.isFinite(bucket.utilization));
  const maxUtilization = sized.length === 0 ? 0 : Math.max(...sized.map((bucket) => bucket.utilization));
  const used = roundTo(maxUtilization, 1);
  const remaining = roundTo(Math.max(0, 100 - maxUtilization), 1);
  const constraining = sized.find((bucket) => bucket.utilization === maxUtilization) ?? sized[0];
  const resetAt = constraining?.resetsAt ?? earliestReset(sized);

  return {
    providerId: "codex",
    status: "ready",
    source: "api",
    label: "Codex",
    plan: prettyPlan(payload.plan_type),
    remaining,
    limit: 100,
    used,
    resetAt,
    detail: constraining ? `Most used: ${constraining.label}` : "Codex usage detected.",
    confidence: 1,
    observedAt: new Date().toISOString(),
    unit: "%",
    buckets,
    account: cleanAccount({
      email: typeof payload.email === "string" ? payload.email : null,
      userId: typeof payload.user_id === "string" ? payload.user_id : null,
      plan: prettyPlan(payload.plan_type)
    })
  };
}

function parseUtilizationBucket(key, value) {
  if (typeof value !== "object") return null;
  const utilization = Number(value.utilization);
  if (!Number.isFinite(utilization)) return null;
  const clamped = Math.max(0, Math.min(100, utilization));
  return {
    key,
    label: CLAUDE_BUCKET_LABELS[key] ?? humanize(key),
    utilization: clamped,
    remainingPercent: roundTo(Math.max(0, 100 - clamped), 1),
    resetsAt: typeof value.resets_at === "string" ? value.resets_at : null,
    extra: null
  };
}

function parseExtraUsage(key, value) {
  if (typeof value !== "object" || !value.is_enabled) return null;
  const limit = numberOrNull(value.monthly_limit);
  const used = numberOrNull(value.used_credits);
  let utilization = numberOrNull(value.utilization);
  if (utilization === null && limit !== null && used !== null && limit > 0) {
    utilization = (used / limit) * 100;
  }
  if (utilization === null) utilization = 0;
  const clamped = Math.max(0, Math.min(100, utilization));
  return {
    key,
    label: CLAUDE_BUCKET_LABELS[key],
    utilization: clamped,
    remainingPercent: roundTo(Math.max(0, 100 - clamped), 1),
    resetsAt: null,
    extra: {
      currency: typeof value.currency === "string" ? value.currency : null,
      limit,
      used
    }
  };
}

function addRateLimitWindows(buckets, baseKey, baseLabel, rateLimit) {
  if (rateLimit.primary_window) {
    const bucket = bucketFromCodexWindow(baseKey, baseLabel, rateLimit.primary_window, "primary");
    if (bucket) buckets.push(bucket);
  }
  if (rateLimit.secondary_window) {
    const bucket = bucketFromCodexWindow(baseKey, baseLabel, rateLimit.secondary_window, "secondary");
    if (bucket) buckets.push(bucket);
  }
}

function bucketFromCodexWindow(baseKey, baseLabel, window, slot) {
  const utilization = numberOrNull(window?.used_percent);
  if (utilization === null) return null;
  const seconds = Number(window.limit_window_seconds) || 0;
  const durationLabel = formatWindowDuration(seconds);
  const clamped = Math.max(0, Math.min(100, utilization));
  return {
    key: slugify(`${baseKey}_${slot}_${seconds || "x"}`),
    label: durationLabel ? `${baseLabel} (${durationLabel})` : baseLabel,
    utilization: clamped,
    remainingPercent: roundTo(Math.max(0, 100 - clamped), 1),
    resetsAt: window.reset_at ? new Date(Number(window.reset_at) * 1000).toISOString() : null,
    extra: null
  };
}

function parseCodexCredits(credits) {
  if (!credits || typeof credits !== "object") return null;
  const overage = Boolean(credits.overage_limit_reached);
  const balance = numberOrNull(credits.balance);
  const hasCredits = Boolean(credits.has_credits) || Boolean(credits.unlimited) || (balance !== null && balance > 0);
  if (!hasCredits && !overage) return null;
  const utilization = overage ? 100 : 0;
  return {
    key: "credits",
    label: "Credits",
    utilization,
    remainingPercent: 100 - utilization,
    resetsAt: null,
    extra: {
      currency: null,
      limit: null,
      used: balance
    }
  };
}

function earliestReset(buckets) {
  const times = buckets
    .filter((bucket) => bucket.resetsAt)
    .map((bucket) => new Date(bucket.resetsAt))
    .filter((date) => !Number.isNaN(date.getTime()))
    .sort((a, b) => a.getTime() - b.getTime());
  return times[0]?.toISOString() ?? null;
}

function orderIndex(key) {
  const index = CLAUDE_BUCKET_ORDER.indexOf(key);
  return index === -1 ? 1000 : index;
}

function humanize(key) {
  return key.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function prettyPlan(plan) {
  if (!plan || typeof plan !== "string") return null;
  return plan.replace(/[_-]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatWindowDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  if (seconds >= 86_400) {
    const days = seconds / 86_400;
    return `${days % 1 === 0 ? days.toFixed(0) : days.toFixed(1)}d`;
  }
  if (seconds >= 3_600) {
    const hours = seconds / 3_600;
    return `${hours % 1 === 0 ? hours.toFixed(0) : hours.toFixed(1)}h`;
  }
  if (seconds >= 60) return `${Math.round(seconds / 60)}m`;
  return `${seconds}s`;
}

function slugify(value) {
  if (!value) return "bucket";
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 63) || "bucket";
}

function cleanAccount(account) {
  const email = typeof account?.email === "string" ? account.email.trim() : null;
  const userId = typeof account?.userId === "string" ? account.userId.trim() : null;
  const plan = typeof account?.plan === "string" ? account.plan.trim() : null;
  if (!email && !userId && !plan) return null;
  return { email: email || null, userId: userId || null, plan: plan || null };
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function roundTo(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
