"use strict";

import { extractClaudeQuota, extractCodexQuota } from "./extractors.js";

const CLAUDE_ORIGIN = "https://claude.ai";
const CHATGPT_ORIGINS = ["https://chatgpt.com", "https://chat.openai.com"];
const CHATGPT_USAGE_PATH = "/backend-api/wham/usage";
const CHATGPT_SESSION_PATH = "/api/auth/session";
const CLAUDE_USAGE_PATH = (orgId) => `/api/organizations/${encodeURIComponent(orgId)}/usage`;
const CLAUDE_ORGS_PATH = "/api/organizations";
const ORG_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const PROVIDER_DEFS = Object.freeze({
  claude: Object.freeze({
    id: "claude",
    name: "Claude",
    origin: CLAUDE_ORIGIN,
    appUrl: "https://claude.ai/new",
    usageUrl: "https://claude.ai/settings/usage",
    matchHosts: ["claude.ai"]
  }),
  codex: Object.freeze({
    id: "codex",
    name: "Codex",
    origin: CHATGPT_ORIGINS[0],
    appUrl: "https://chatgpt.com/codex",
    usageUrl: "https://chatgpt.com/codex/cloud/settings/analytics",
    matchHosts: ["chatgpt.com", "chat.openai.com"]
  })
});

const CLAUDE_HEADERS = {
  "anthropic-client-platform": "web_claude_ai",
  "anthropic-client-version": "1.0.0"
};

export async function fetchClaudeUsage({ runtime } = {}) {
  // Direct first so the request is visible in the new tab's Network tab.
  // DNR rewrites Sec-Fetch-Site/Origin/Referer, anthropic-client-platform is
  // attached, cookies flow via credentials:include + host_permissions. We probe
  // every org from /api/organizations because lastActiveOrg cookie isn't
  // readable without the `cookies` permission.
  console.debug("[tokenxiety] claude: trying direct cross-origin fetch");
  const direct = await fetchClaudeUsageDirect(runtime);
  if (direct?.quota?.status === "ready") {
    console.debug("[tokenxiety] claude: direct OK ·", direct.quota.buckets?.length ?? 0, "buckets · org", direct.runtime?.orgId);
    return direct;
  }
  console.debug("[tokenxiety] claude: direct returned", direct?.quota?.status, "·", direct?.quota?.detail, "→ trying relay");

  // Fallback: content-script relay running on a claude.ai tab. This call fires
  // from the claude.ai tab's network (not visible in the new tab's DevTools).
  const viaRelay = await fetchClaudeUsageViaRelay();
  if (viaRelay?.quota?.status === "ready") {
    console.debug("[tokenxiety] claude: relay OK ·", viaRelay.quota.buckets?.length ?? 0, "buckets · org", viaRelay.runtime?.orgId);
    return viaRelay;
  }
  if (viaRelay) {
    console.debug("[tokenxiety] claude: relay returned", viaRelay.quota?.status, "·", viaRelay.quota?.detail);
  } else {
    console.debug("[tokenxiety] claude: no relay tab open");
  }

  // Both failed — prefer the direct error since that's the visible path.
  if (direct) return direct;
  if (viaRelay) return viaRelay;
  return {
    runtime: {},
    quota: errorQuota("claude", "Claude refresh failed via both direct and relay paths.")
  };
}

async function fetchClaudeUsageDirect(runtime) {
  let orgId = runtime?.orgId && ORG_ID_RE.test(runtime.orgId) ? runtime.orgId : null;
  let plan = runtime?.plan ?? null;
  let displayName = runtime?.displayName ?? null;

  if (!orgId) {
    const orgs = await callJson(`${CLAUDE_ORIGIN}${CLAUDE_ORGS_PATH}`, { headers: CLAUDE_HEADERS });
    if (orgs.kind !== "ok") return loginOrError("claude", orgs);
    const candidates = listOrgCandidates(orgs.payload);
    if (candidates.length === 0) {
      return {
        runtime: { orgId: null, plan: null, displayName: null },
        quota: loginRequiredQuota("claude", "Open https://claude.ai while logged in to discover the active organization.")
      };
    }

    for (const candidate of candidates) {
      const probe = await callJson(`${CLAUDE_ORIGIN}${CLAUDE_USAGE_PATH(candidate.uuid)}`, { headers: CLAUDE_HEADERS });
      if (probe.kind === "ok") {
        const account = { email: null, userId: candidate.uuid, plan: prettyPlan(candidate.plan), name: candidate.name };
        const quota = extractClaudeQuota(probe.payload, account);
        return {
          runtime: { orgId: candidate.uuid, plan: candidate.plan ?? null, displayName: candidate.name ?? null },
          quota: quota ?? errorQuota("claude", "Claude /usage response did not contain recognizable fields."),
          rawPayload: probe.payload
        };
      }
      if (probe.kind === "auth" && candidates.length === 1) {
        return loginOrError("claude", probe, { orgId: candidate.uuid });
      }
    }

    return {
      runtime: { orgId: null },
      quota: errorQuota("claude", `None of ${candidates.length} Claude orgs returned usage. Open claude.ai/settings/usage once and try again.`)
    };
  }

  const usage = await callJson(`${CLAUDE_ORIGIN}${CLAUDE_USAGE_PATH(orgId)}`, { headers: CLAUDE_HEADERS });
  if (usage.kind !== "ok") return loginOrError("claude", usage, { orgId, plan, displayName });

  const accountForCached = { email: null, userId: orgId, plan: prettyPlan(plan), name: displayName };
  const quotaForCached = extractClaudeQuota(usage.payload, accountForCached);
  return {
    runtime: { orgId, plan, displayName },
    quota: quotaForCached ?? errorQuota("claude", "Claude /usage response did not contain recognizable fields."),
    rawPayload: usage.payload
  };
}

export async function fetchCodexUsage() {
  // ChatGPT's /backend-api/wham/usage requires a Bearer access token; the
  // cookie-only call is observed to always return 401 against current accounts.
  // So skip the wasted cookie-only attempt and go straight to bearer.
  let lastDetail = "Codex usage endpoint not reachable.";

  for (const origin of CHATGPT_ORIGINS) {
    const accessToken = await readChatGptAccessToken(origin);
    if (!accessToken) {
      lastDetail = `No access token at ${origin} (open chatgpt.com once while logged in).`;
      continue;
    }

    const result = await callJson(`${origin}${CHATGPT_USAGE_PATH}`, {
      headers: { authorization: `Bearer ${accessToken}` }
    });

    if (result.kind === "ok") {
      const quota = extractCodexQuota(result.payload);
      return {
        runtime: { lastFetchedAt: new Date().toISOString() },
        quota: quota ?? errorQuota("codex", "Codex /usage response did not contain recognizable fields."),
        rawPayload: result.payload
      };
    }

    if (result.kind === "auth") {
      return {
        runtime: { lastFetchedAt: new Date().toISOString() },
        quota: loginRequiredQuota("codex", result.detail)
      };
    }

    lastDetail = result.detail ?? lastDetail;
    if (result.kind !== "not_found" && result.kind !== "blocked") break;
  }

  return {
    runtime: {},
    quota: errorQuota("codex", `${lastDetail} Open chatgpt.com once while logged in.`)
  };
}

async function callJson(url, { headers = {} } = {}) {
  const direct = await callDirect(url, headers);
  if (direct.kind === "ok") return direct;

  // Fall back to a same-origin fetch via the content-script relay running in
  // an open claude.ai / chatgpt.com tab. This is the bullet-proof path because
  // the tab already has the right cookies, TLS fingerprint, Origin, and Referer.
  if (direct.kind === "auth" || direct.kind === "blocked" || direct.kind === "error") {
    const relayed = await callViaRelay(url, headers);
    if (relayed.kind === "ok") return relayed;
    if (relayed.kind === "auth" || relayed.kind === "error") return relayed;
  }

  return direct;
}

async function callDirect(url, headers) {
  const init = {
    method: "GET",
    credentials: "include",
    cache: "no-store",
    redirect: "follow"
  };

  if (Object.keys(headers).length > 0) {
    init.headers = headers;
  }

  let response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    console.warn("[tokenxiety] fetch threw", url, error);
    return { kind: "blocked", detail: `Network blocked at ${safeOrigin(url)}: ${stringifyError(error)}` };
  }

  console.debug("[tokenxiety] fetched", url, response.status, response.headers.get("content-type"));

  if (response.status === 404) return { kind: "not_found", detail: `${safeOrigin(url)} 404` };

  if (response.status === 401 || response.status === 403) {
    let body = "";
    try { body = (await response.clone().text()).slice(0, 4000); } catch { body = ""; }
    if (/just a moment|cloudflare/i.test(body)) {
      return { kind: "auth", detail: `Cloudflare challenge from ${safeOrigin(url)}. Open the provider once to clear cf_clearance.` };
    }
    return { kind: "auth", detail: `${response.status} from ${safeOrigin(url)}. Re-login to the provider.` };
  }

  if (response.status === 429) {
    const retryAfter = Number(response.headers.get("retry-after")) || 300;
    return { kind: "error", detail: `${safeOrigin(url)} rate limited (429). Retry in ${retryAfter}s.` };
  }

  if (!response.ok) {
    return { kind: "error", detail: `${safeOrigin(url)} HTTP ${response.status}.` };
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return { kind: "error", detail: `${safeOrigin(url)} non-JSON (${contentType || "unknown"}).` };
  }

  try {
    const payload = await response.json();
    return { kind: "ok", payload };
  } catch (error) {
    return { kind: "error", detail: `${safeOrigin(url)} invalid JSON: ${stringifyError(error)}` };
  }
}

async function fetchClaudeUsageViaRelay() {
  const tabs = await findRelayTabs("https://claude.ai/");
  if (!tabs.length) return null;

  for (const tab of tabs) {
    const response = await sendRelayMessage(tab.id, "tokenxiety:claude-usage");
    if (!response) continue;

    if (response.ok && response.contentType?.includes("application/json")) {
      let payload;
      try {
        payload = JSON.parse(response.body);
      } catch (error) {
        return {
          runtime: { orgId: response.orgId },
          quota: errorQuota("claude", `relay JSON parse failed: ${stringifyError(error)}`)
        };
      }
      const account = { email: null, userId: response.orgId, plan: null, name: null };
      const quota = extractClaudeQuota(payload, account);
      return {
        runtime: { orgId: response.orgId },
        quota: quota ?? errorQuota("claude", "Claude /usage response did not contain recognizable fields."),
        rawPayload: payload
      };
    }

    if (response.status === 401 || response.status === 403) {
      return {
        runtime: { orgId: response.orgId ?? null },
        quota: loginRequiredQuota("claude", `Claude returned ${response.status} via relay. Refresh claude.ai once.`)
      };
    }

    if (typeof response.status === "number") {
      return {
        runtime: { orgId: response.orgId ?? null },
        quota: errorQuota("claude", `Claude relay HTTP ${response.status}.`)
      };
    }

    return {
      runtime: { orgId: response.orgId ?? null },
      quota: errorQuota("claude", response.detail ?? "relay returned no payload")
    };
  }

  return null;
}

async function callViaRelay(url, headers) {
  const tabs = await findRelayTabs(url);
  if (!tabs.length) {
    return { kind: "blocked", detail: `Open ${safeOrigin(url)} in a tab so Tokenxiety can fetch quota in same-origin context.` };
  }

  for (const tab of tabs) {
    const response = await sendRelayMessage(tab.id, url, headers, undefined);
    if (!response) continue;

    if (response.ok && response.contentType?.includes("application/json")) {
      try {
        return { kind: "ok", payload: JSON.parse(response.body) };
      } catch (error) {
        return { kind: "error", detail: `relay JSON parse failed: ${stringifyError(error)}` };
      }
    }

    if (response.status === 401 || response.status === 403) {
      return { kind: "auth", detail: `${response.status} from ${safeOrigin(url)} (relay).` };
    }

    if (typeof response.status === "number") {
      return { kind: "error", detail: `${safeOrigin(url)} relay HTTP ${response.status}.` };
    }

    return { kind: "error", detail: response.detail ?? "relay returned no payload" };
  }

  return { kind: "blocked", detail: `No claude.ai/chatgpt.com tab responded for ${safeOrigin(url)}.` };
}

async function findRelayTabs(url) {
  const ext = globalThis.browser ?? globalThis.chrome;
  if (!ext?.tabs?.query) {
    console.debug("[tokenxiety] tabs API unavailable");
    return [];
  }
  const target = new URL(url);
  const prefix = `${target.protocol}//${target.host}/`;

  const queryAll = () => new Promise((resolve) => {
    try {
      ext.tabs.query({}, (value) => resolve(value ?? []));
    } catch (error) {
      console.debug("[tokenxiety] tabs.query threw", error);
      resolve([]);
    }
  });

  const allTabs = await queryAll();
  const matching = allTabs.filter((tab) =>
    Number.isInteger(tab.id) &&
    typeof tab.url === "string" &&
    tab.url.startsWith(prefix)
  );

  console.debug(`[tokenxiety] findRelayTabs(${target.host}): ${allTabs.length} total tabs, ${matching.length} matching`,
    matching.map((tab) => tab.url));
  return matching;
}

function sendRelayMessage(tabId, typeOrUrl, urlMaybe, headersMaybe) {
  // Two call shapes:
  //   sendRelayMessage(tabId, "tokenxiety:claude-usage")
  //   sendRelayMessage(tabId, url, headers)  // legacy (kept for callViaRelay)
  let message;
  if (typeof typeOrUrl === "string" && typeOrUrl.startsWith("tokenxiety:")) {
    message = { type: typeOrUrl };
  } else {
    message = { type: "tokenxiety:relay-fetch", url: typeOrUrl, headers: urlMaybe };
    void headersMaybe;
  }

  const ext = globalThis.browser ?? globalThis.chrome;
  if (!ext?.tabs?.sendMessage) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      ext.tabs.sendMessage(tabId, message, (response) => {
        const error = ext.runtime?.lastError;
        if (error) resolve(null);
        else resolve(response);
      });
    } catch {
      resolve(null);
    }
  });
}

async function readChatGptAccessToken(origin) {
  const result = await callJson(`${origin}${CHATGPT_SESSION_PATH}`);
  if (result.kind !== "ok") return null;
  const token = result.payload?.accessToken;
  return typeof token === "string" && token.length > 0 ? token : null;
}

function pickActiveOrg(orgs) {
  const candidates = listOrgCandidates(orgs);
  return candidates[0] ?? null;
}

function listOrgCandidates(orgs) {
  if (!Array.isArray(orgs)) return [];
  const usable = orgs
    .filter((org) => org?.uuid && ORG_ID_RE.test(org.uuid))
    .map((org) => ({
      uuid: org.uuid,
      plan: org.billing_type ?? org.plan ?? null,
      name: org.name ?? org.organization_name ?? null,
      is_active: Boolean(org.is_active)
    }));

  // Prefer is_active=true, then orgs with chat capability, then anything.
  return [...usable].sort((a, b) => Number(b.is_active) - Number(a.is_active));
}

function loginOrError(providerId, result, runtime) {
  if (result.kind === "auth") return { runtime, quota: loginRequiredQuota(providerId, result.detail) };
  return { runtime, quota: errorQuota(providerId, result.detail ?? "Unknown error") };
}

function loginRequiredQuota(providerId, detail) {
  return {
    providerId,
    status: "login_required",
    source: "api",
    label: providerId === "claude" ? "Claude" : "Codex",
    detail,
    confidence: 0.7,
    observedAt: new Date().toISOString()
  };
}

function errorQuota(providerId, detail) {
  return {
    providerId,
    status: "error",
    source: "api",
    label: providerId === "claude" ? "Claude" : "Codex",
    detail,
    confidence: 0.6,
    observedAt: new Date().toISOString()
  };
}

function safeOrigin(url) {
  try { return new URL(url).origin; } catch { return "endpoint"; }
}

function prettyPlan(plan) {
  if (!plan || typeof plan !== "string") return null;
  return plan.replace(/[_-]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function stringifyError(error) {
  if (!error) return "unknown error";
  if (error instanceof Error) return error.message;
  return String(error);
}
