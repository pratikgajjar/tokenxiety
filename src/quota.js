"use strict";

import { PROVIDER_DEFS } from "./providers.js";

export function listProviders() {
  return Object.values(PROVIDER_DEFS);
}

export function enabledProviders(config) {
  return Object.values(PROVIDER_DEFS).filter((provider) => config.providers?.[provider.id] !== false);
}

export function providerDisplayState({ provider, quota, history, refreshMinutes = 5, errorMessage }) {
  if (errorMessage) {
    return {
      provider,
      status: "error",
      severity: "error",
      label: provider.name,
      detail: errorMessage,
      buckets: [],
      observedAt: null,
      stale: true
    };
  }

  if (!quota) {
    return {
      provider,
      status: "not_found",
      severity: "unknown",
      label: provider.name,
      detail: `Open ${provider.name} once while logged in so Tokenxiety can sync.`,
      buckets: [],
      observedAt: null,
      stale: true
    };
  }

  const stale = isOlderThanMinutes(quota.observedAt, Math.max(refreshMinutes * 3, 15));
  const buckets = (quota.buckets ?? []).map((bucket) => enrichBucket(bucket, history?.[bucket.key] ?? []));

  return {
    provider,
    status: quota.status,
    severity: severityFor(quota),
    label: quota.label || provider.name,
    plan: quota.plan,
    detail: quota.detail,
    source: quota.source,
    confidence: quota.confidence,
    remaining: quota.remaining,
    used: quota.used,
    limit: quota.limit,
    unit: quota.unit ?? null,
    resetAt: quota.resetAt,
    observedAt: quota.observedAt,
    account: quota.account ?? null,
    stale,
    buckets
  };
}

function severityFor(quota) {
  if (quota.status === "ready") return severityForUtilization(quota.used ?? 0);
  if (quota.status === "login_required") return "login";
  if (quota.status === "error") return "error";
  return "unknown";
}

function severityForUtilization(percent) {
  if (percent >= 90) return "critical";
  if (percent >= 70) return "warning";
  if (percent >= 40) return "active";
  return "calm";
}

function enrichBucket(bucket, samples) {
  const enriched = {
    ...bucket,
    severity: severityForUtilization(bucket.utilization),
    sparkline: samples.slice(-72),
    pace: pacePerHour(samples),
    timeToExhaustHours: null
  };
  if (enriched.pace > 0) {
    const remaining = Math.max(0, 100 - bucket.utilization);
    enriched.timeToExhaustHours = remaining / enriched.pace;
  }
  return enriched;
}

function pacePerHour(samples) {
  if (!samples || samples.length < 2) return 0;
  const window = samples.slice(-24);
  const first = window[0];
  const last = window[window.length - 1];
  const elapsedHours = (new Date(last.t).getTime() - new Date(first.t).getTime()) / 3_600_000;
  if (!Number.isFinite(elapsedHours) || elapsedHours <= 0) return 0;
  const delta = last.u - first.u;
  return delta / elapsedHours;
}

function isOlderThanMinutes(value, minutes) {
  if (!value) return true;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return true;
  return Date.now() - date.getTime() > Math.max(Number(minutes) || 5, 1) * 60 * 1000;
}
