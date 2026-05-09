"use strict";

import {
  dbAppendBucketSampleIfChanged,
  dbClearAll,
  dbLoadAllQuotas,
  dbLoadBucketSamples,
  dbLoadSnapshots,
  dbOnChange,
  dbSaveQuotaIfChanged
} from "./db.js";

const CONFIG_KEY = "config";
const RUNTIME_KEY = "providerRuntime";

const DEFAULT_CONFIG = Object.freeze({
  refreshMinutes: 1,
  providers: Object.freeze({ claude: true, codex: true })
});

const ALLOWED_STATUSES = ["ready", "not_found", "login_required", "error"];
const ALLOWED_SOURCES = ["api", "network", "dom", "session", "manual"];

const storageApi = globalThis.browser?.storage?.local ?? globalThis.chrome?.storage?.local;

/* -------------------- chrome.storage.local helpers -------------------- */

export function get(keys) {
  if (!storageApi) return Promise.resolve({});
  if (globalThis.browser?.storage?.local) return globalThis.browser.storage.local.get(keys);
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (value) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(value);
    });
  });
}

export function set(value) {
  if (!storageApi) return Promise.resolve();
  if (globalThis.browser?.storage?.local) return globalThis.browser.storage.local.set(value);
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(value, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(value);
    });
  });
}

/* -------------------- config (chrome.storage.local) -------------------- */

export async function loadConfig() {
  const value = await get([CONFIG_KEY]);
  return mergeConfig(value[CONFIG_KEY]);
}

export async function saveConfig(config) {
  await set({ [CONFIG_KEY]: mergeConfig(config) });
}

export function onConfigChange(handler) {
  if (!chrome.storage?.onChanged?.addListener) return () => {};
  const listener = (changes, area) => {
    if (area === "local" && changes[CONFIG_KEY]) handler(mergeConfig(changes[CONFIG_KEY].newValue));
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

export function mergeConfig(config = {}) {
  return {
    refreshMinutes: clampInteger(config.refreshMinutes, 1, 240, DEFAULT_CONFIG.refreshMinutes),
    providers: {
      claude: config.providers?.claude !== false,
      codex: config.providers?.codex !== false
    }
  };
}

/* -------------------- provider runtime (small, chrome.storage.local) -------------------- */

export async function loadProviderRuntime(providerId) {
  const value = await get([RUNTIME_KEY]);
  const all = value[RUNTIME_KEY] ?? {};
  return all[providerId] ?? {};
}

export async function saveProviderRuntime(providerId, runtime) {
  const value = await get([RUNTIME_KEY]);
  const all = value[RUNTIME_KEY] ?? {};
  all[providerId] = sanitizeRuntime({ ...(all[providerId] ?? {}), ...(runtime ?? {}) });
  await set({ [RUNTIME_KEY]: all });
}

/* -------------------- quota cache (IndexedDB) -------------------- */

export async function loadProviderQuotaCache() {
  const records = await dbLoadAllQuotas();
  const providers = {};
  let updatedAt = null;
  for (const [providerId, record] of Object.entries(records)) {
    const sanitized = sanitizeQuotaForStorage({ ...record, providerId });
    if (!sanitized) continue;
    sanitized._lastObservedAt = msToIso(record._lastObservedAtMs) ?? sanitized.observedAt;
    sanitized._firstObservedAt = msToIso(record._firstObservedAtMs) ?? sanitized.observedAt;
    providers[providerId] = sanitized;
    if (!updatedAt || sanitized._lastObservedAt > updatedAt) updatedAt = sanitized._lastObservedAt;
  }
  return { providers, updatedAt };
}

export async function saveProviderQuota(providerId, quota, rawPayload) {
  const sanitized = sanitizeQuotaForStorage({ ...quota, providerId });
  if (!sanitized) return null;

  const result = await dbSaveQuotaIfChanged(providerId, sanitized, rawPayload);

  // Always attempt to append a sample for every bucket. The append function
  // dedupes against the last stored value, so unchanged buckets are no-ops.
  // This keeps history correct even if the snapshot-level hash thinks
  // "nothing changed" but a single bucket actually moved.
  if (Array.isArray(sanitized.buckets)) {
    for (const bucket of sanitized.buckets) {
      await dbAppendBucketSampleIfChanged(providerId, bucket.key, {
        t: sanitized.observedAt,
        u: bucket.utilization
      });
    }
  }

  return result.quota;
}

export async function loadProviderSnapshots(providerId, options) {
  return dbLoadSnapshots(providerId, options);
}

export async function clearProviderQuotaCache() {
  await dbClearAll();
}

/* -------------------- history (IndexedDB) -------------------- */

export async function loadProviderHistory() {
  const result = {};
  for (const providerId of ["claude", "codex"]) {
    const grouped = await dbLoadBucketSamples(providerId);
    const out = {};
    for (const [bucketKey, samples] of Object.entries(grouped)) {
      out[bucketKey] = samples.map((sample) => ({ t: msToIso(sample.tMs), u: sample.u })).filter((sample) => sample.t);
    }
    if (Object.keys(out).length) result[providerId] = out;
  }
  return result;
}

function msToIso(value) {
  if (!Number.isFinite(value)) return null;
  return new Date(value).toISOString();
}

/* -------------------- change events -------------------- */

export function onQuotaChange(handler) {
  return dbOnChange(handler);
}

/* -------------------- sanitizers -------------------- */

function sanitizeQuotaForStorage(quota) {
  if (!quota || typeof quota !== "object") return null;
  const providerId = safeToken(quota.providerId);
  if (!providerId) return null;
  return {
    providerId,
    status: enumValue(quota.status, ALLOWED_STATUSES, "not_found"),
    source: enumValue(quota.source, ALLOWED_SOURCES, "manual"),
    label: limitText(quota.label, 80),
    plan: limitText(quota.plan, 80),
    remaining: nullableFiniteNumber(quota.remaining),
    limit: nullableFiniteNumber(quota.limit),
    used: nullableFiniteNumber(quota.used),
    unit: limitText(quota.unit, 8),
    resetAt: asIsoDate(quota.resetAt) ?? limitText(quota.resetAt, 80),
    observedAt: asIsoDate(quota.observedAt) ?? new Date().toISOString(),
    detail: limitText(quota.detail, 200),
    confidence: clampNumber(quota.confidence, 0, 1, 0),
    account: sanitizeAccount(quota.account),
    buckets: sanitizeBuckets(quota.buckets)
  };
}

function sanitizeAccount(account) {
  if (!account || typeof account !== "object") return null;
  const email = sanitizeEmail(account.email);
  const userId = limitText(account.userId, 80);
  const plan = limitText(account.plan, 80);
  const name = limitText(account.name, 120);
  if (!email && !userId && !plan && !name) return null;
  return { email, userId, plan, name };
}

function sanitizeEmail(value) {
  const text = limitText(value, 254);
  if (!text) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) ? text : null;
}

function sanitizeBuckets(buckets) {
  if (!Array.isArray(buckets)) return [];
  return buckets
    .slice(0, 16)
    .map((bucket) => {
      if (!bucket || typeof bucket !== "object") return null;
      const key = safeToken(bucket.key, 64);
      if (!key) return null;
      const utilization = clampNumber(bucket.utilization, 0, 100, 0);
      return {
        key,
        label: limitText(bucket.label, 80) ?? key,
        utilization,
        remainingPercent: clampNumber(bucket.remainingPercent, 0, 100, Math.max(0, 100 - utilization)),
        resetsAt: asIsoDate(bucket.resetsAt) ?? null,
        extra: sanitizeBucketExtra(bucket.extra)
      };
    })
    .filter(Boolean);
}

function sanitizeBucketExtra(extra) {
  if (!extra || typeof extra !== "object") return null;
  return {
    currency: limitText(extra.currency, 8),
    limit: nullableFiniteNumber(extra.limit),
    used: nullableFiniteNumber(extra.used)
  };
}

function sanitizeRuntime(runtime) {
  return {
    orgId: limitText(runtime.orgId, 80),
    plan: limitText(runtime.plan, 80),
    displayName: limitText(runtime.displayName, 120),
    lastFetchedAt: asIsoDate(runtime.lastFetchedAt) ?? null
  };
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

function nullableFiniteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function limitText(value, max) {
  if (value === null || value === undefined) return null;
  const cleaned = String(value).replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return cleaned.slice(0, max) || null;
}

function safeToken(value, max = 40) {
  const text = limitText(value, max);
  return /^[a-z0-9_-]+$/i.test(text ?? "") ? text : null;
}

function asIsoDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function enumValue(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}
