"use strict";

// Same-origin fetch relay. Runs on claude.ai / chatgpt.com tabs and answers
// {type: "tokenxiety:relay-fetch"} and {type: "tokenxiety:claude-usage"} messages
// from the new tab page. The tab already has the right cookies (HttpOnly &
// SameSite=Lax included), TLS fingerprint, Sec-Fetch-Site, and Referer, so
// this bypasses every cross-origin restriction the extension page hits.

const HOST = window.location.host;
const ALLOWED_ORIGINS = new Set([
  "https://claude.ai",
  "https://chatgpt.com",
  "https://chat.openai.com"
]);

const CLAUDE_HEADERS = {
  accept: "application/json, text/plain, */*",
  "anthropic-client-platform": "web_claude_ai",
  "anthropic-client-version": "1.0.0"
};

const ORG_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const extensionApi = globalThis.browser ?? globalThis.chrome;
if (extensionApi?.runtime?.onMessage) {
  extensionApi.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== "object") return false;

    if (message.type === "tokenxiety:relay-fetch") {
      handleRelayFetch(message)
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, detail: stringify(error) }));
      return true;
    }

    if (message.type === "tokenxiety:claude-usage") {
      handleClaudeUsage()
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, detail: stringify(error) }));
      return true;
    }

    return false;
  });
}

async function handleRelayFetch({ url, headers }) {
  let target;
  try {
    target = new URL(url);
  } catch (error) {
    return { ok: false, detail: `Invalid URL: ${stringify(error)}` };
  }

  if (!ALLOWED_ORIGINS.has(target.origin)) {
    return { ok: false, detail: `Origin not allowed: ${target.origin}` };
  }
  if (target.host !== HOST) {
    return { ok: false, detail: `Tab host mismatch (${HOST} cannot fetch ${target.host})` };
  }

  let response;
  try {
    response = await fetch(target.toString(), {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      headers: sanitizeHeaders(headers)
    });
  } catch (error) {
    return { ok: false, detail: `relay fetch threw: ${stringify(error)}` };
  }

  const contentType = response.headers.get("content-type") ?? "";
  let body;
  try {
    body = await response.text();
  } catch (error) {
    return { ok: false, status: response.status, detail: `read body failed: ${stringify(error)}` };
  }

  return { ok: response.ok, status: response.status, contentType, body };
}

async function handleClaudeUsage() {
  if (HOST !== "claude.ai") {
    return { ok: false, detail: `Relay tab is not claude.ai (host=${HOST})` };
  }

  const orgId = await resolveActiveOrgId();
  if (!orgId) {
    return { ok: false, detail: "Could not resolve active Claude organization." };
  }

  const url = `https://claude.ai/api/organizations/${encodeURIComponent(orgId)}/usage`;
  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      headers: CLAUDE_HEADERS
    });
  } catch (error) {
    return { ok: false, detail: `claude usage fetch threw: ${stringify(error)}`, orgId };
  }

  const contentType = response.headers.get("content-type") ?? "";
  let body;
  try {
    body = await response.text();
  } catch (error) {
    return { ok: false, status: response.status, detail: `read body failed: ${stringify(error)}`, orgId };
  }

  return { ok: response.ok, status: response.status, contentType, body, orgId };
}

async function resolveActiveOrgId() {
  const cookieOrgId = readCookie("lastActiveOrg");
  if (cookieOrgId && ORG_ID_RE.test(cookieOrgId)) return cookieOrgId;

  // Fallback: enumerate organizations and look for the active one.
  let response;
  try {
    response = await fetch("https://claude.ai/api/organizations", {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      headers: CLAUDE_HEADERS
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;

  let payload;
  try {
    payload = await response.json();
  } catch {
    return null;
  }
  if (!Array.isArray(payload)) return null;

  const usable = payload.filter((org) => org?.uuid && ORG_ID_RE.test(org.uuid));
  if (usable.length === 0) return null;

  const active = usable.find((org) => org?.is_active === true)
    ?? usable.find((org) => Array.isArray(org?.capabilities) && org.capabilities.includes("chat"))
    ?? usable[0];
  return active?.uuid ?? null;
}

function readCookie(name) {
  const cookieString = document.cookie ?? "";
  const parts = cookieString.split(";");
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq);
    if (key === name) return decodeURIComponent(trimmed.slice(eq + 1));
  }
  return null;
}

function sanitizeHeaders(headers) {
  if (!headers || typeof headers !== "object") return undefined;
  const safe = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof name !== "string" || typeof value !== "string") continue;
    if (name.length > 80 || value.length > 1024) continue;
    if (/^(cookie|host|authorization)$/i.test(name)) continue;
    safe[name] = value;
  }
  return safe;
}

function stringify(error) {
  if (!error) return "unknown error";
  if (error instanceof Error) return error.message;
  return String(error);
}
