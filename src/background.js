"use strict";

/**
 * Tokenxiety background service worker.
 *
 * Runs a chrome.alarms-driven cron (period = config.refreshMinutes, default
 * 1 min in dev / 5 min in prod) so quota snapshots accumulate even when no
 * new tab is open. Both providers are refreshed if their cache is stale; the
 * IndexedDB diff layer dedupes writes when nothing changed.
 *
 * The new tab and options pages still trigger their own refreshes when the
 * user opens them — that's a separate code path that respects the same TTL.
 */

import { fetchClaudeUsage, fetchCodexUsage } from "./providers.js";
import {
  loadConfig,
  loadProviderQuotaCache,
  loadProviderRuntime,
  saveProviderQuota,
  saveProviderRuntime
} from "./storage.js";
import { enabledProviders } from "./quota.js";

const ALARM_NAME = "tokenxiety:refresh";
const FALLBACK_INTERVAL_MIN = 5;
const MIN_INTERVAL_MIN = 1;

chrome.runtime.onInstalled.addListener((details) => {
  console.debug("[tokenxiety] sw onInstalled", details.reason);
  scheduleAndRun("install").catch(reportError);
});

chrome.runtime.onStartup.addListener(() => {
  console.debug("[tokenxiety] sw onStartup");
  scheduleAndRun("startup").catch(reportError);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  console.debug("[tokenxiety] sw alarm fired");
  refreshAllProviders("alarm").catch(reportError);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.config) {
    console.debug("[tokenxiety] sw config changed → re-scheduling alarm");
    scheduleAlarm().catch(reportError);
  }
});

// Allow the new tab / options page to ask the SW to refresh on demand. Returns
// {ok: true} once writes complete so the caller can re-render.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "tokenxiety:refresh") return false;
  refreshAllProviders(message.reason ?? "manual")
    .then(() => sendResponse({ ok: true }))
    .catch((error) => {
      reportError(error);
      sendResponse({ ok: false, error: stringifyError(error) });
    });
  return true; // async sendResponse
});

async function scheduleAndRun(reason) {
  await scheduleAlarm();
  await refreshAllProviders(reason);
}

async function scheduleAlarm() {
  const config = await loadConfig();
  const minutes = Math.max(Number(config.refreshMinutes) || FALLBACK_INTERVAL_MIN, MIN_INTERVAL_MIN);
  await chrome.alarms.clear(ALARM_NAME);
  await chrome.alarms.create(ALARM_NAME, { periodInMinutes: minutes });
  console.debug(`[tokenxiety] sw alarm scheduled · every ${minutes} min`);
}

async function refreshAllProviders(reason) {
  const config = await loadConfig();
  const cache = await loadProviderQuotaCache();
  const ttlMs = Math.max(Number(config.refreshMinutes) || FALLBACK_INTERVAL_MIN, MIN_INTERVAL_MIN) * 60 * 1000;
  const providers = enabledProviders(config);

  const work = providers.map(async (provider) => {
    const quota = cache.providers[provider.id];
    if (isFresh(quota, ttlMs)) {
      console.debug(`[tokenxiety] sw ${reason}: ${provider.id} cache fresh, skipping`);
      return;
    }
    try {
      const runtime = await loadProviderRuntime(provider.id);
      const result = provider.id === "claude"
        ? await fetchClaudeUsage({ runtime })
        : await fetchCodexUsage({ runtime });
      if (result.runtime) await saveProviderRuntime(provider.id, result.runtime);
      if (result.quota) await saveProviderQuota(provider.id, result.quota, result.rawPayload);
      console.debug(`[tokenxiety] sw ${reason}: ${provider.id} → ${result.quota?.status ?? "no-quota"}`);
    } catch (error) {
      console.warn(`[tokenxiety] sw ${reason}: ${provider.id} failed`, error);
    }
  });

  await Promise.all(work);
}

function isFresh(quota, ttlMs) {
  if (!quota || quota.status !== "ready") return false;
  const observed = quota._lastObservedAt ?? quota.observedAt;
  if (!observed) return false;
  const ms = new Date(observed).getTime();
  return Number.isFinite(ms) && Date.now() - ms < ttlMs;
}

function reportError(error) {
  console.warn("[tokenxiety] sw error", stringifyError(error));
}

function stringifyError(error) {
  if (!error) return "unknown error";
  if (error instanceof Error) return error.message;
  return String(error);
}
