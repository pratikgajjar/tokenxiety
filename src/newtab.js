"use strict";

import { fetchClaudeUsage, fetchCodexUsage, PROVIDER_DEFS } from "./providers.js";
import {
  loadConfig,
  saveConfig,
  loadProviderQuotaCache,
  loadProviderHistory,
  loadProviderRuntime,
  saveProviderQuota,
  saveProviderRuntime,
  onConfigChange,
  onQuotaChange
} from "./storage.js";
import { enabledProviders } from "./quota.js";

const DOMS = {
  versionTag: document.querySelector("#versionTag"),
  refreshButton: document.querySelector("#refreshButton"),
  settingsButton: document.querySelector("#settingsButton"),
  nowLabel: document.querySelector("#nowLabel"),
  syncedLabel: document.querySelector("#syncedLabel"),
  providerGrid: document.querySelector("#providerGrid"),
  heatmapTabs: document.querySelector("#heatmapTabs"),
  heatmapMonths: document.querySelector("#heatmapMonths"),
  heatmapGrid: document.querySelector("#heatmapGrid"),
  heatmapLegend: document.querySelector("#heatmapLegend"),
  heatmapTotal: document.querySelector("#heatmapTotal"),
  activityTotals: document.querySelector("#activityTotals")
};

const TEMPLATES = {
  hero: document.querySelector("#providerHeroTemplate"),
  rest: document.querySelector("#restRowTemplate")
};

const PROVIDER_THEME = { claude: "is-claude", codex: "is-codex" };

// Mirror Anthropic's claude.ai/settings/usage labels exactly. The `short`
// codes are our own compact tags used in the per-row "id" line.
const BUCKET_LABEL_OVERRIDES = {
  claude: {
    five_hour:           { name: "Current session",  short: "SESSION", windowSeconds: 18000 },
    seven_day:           { name: "All models",       short: "ALL·7D",  windowSeconds: 604800 },
    seven_day_sonnet:    { name: "Sonnet only",      short: "SONNET",  windowSeconds: 604800 },
    seven_day_opus:      { name: "Opus only",        short: "OPUS",    windowSeconds: 604800 },
    seven_day_omelette:  { name: "Claude Design",    short: "DESIGN",  windowSeconds: 604800 },
    seven_day_cowork:    { name: "Co-work",          short: "COWORK",  windowSeconds: 604800 },
    seven_day_oauth_apps:{ name: "OAuth apps",       short: "OAUTH",   windowSeconds: 604800 },
    extra_usage:         { name: "Top-up credits",   short: "CREDITS", windowSeconds: 0 }
  }
};

let heatmapView = "both";
let inFlightRefresh = null;
let livePulse = null;

initialize();

function initialize() {
  if (DOMS.versionTag && chrome.runtime?.getManifest) {
    const manifest = chrome.runtime.getManifest();
    DOMS.versionTag.textContent = `v${manifest.version}`;
  }

  DOMS.refreshButton?.addEventListener("click", () => triggerRefresh({ force: true }));
  DOMS.settingsButton?.addEventListener("click", () => chrome.runtime.openOptionsPage?.());

  DOMS.heatmapTabs?.addEventListener("click", (event) => {
    const target = event.target instanceof HTMLElement ? event.target.closest(".heatmap-tab") : null;
    if (!target?.dataset?.view) return;
    heatmapView = target.dataset.view;
    DOMS.heatmapTabs.querySelectorAll(".heatmap-tab").forEach((tab) => {
      tab.classList.toggle("is-active", tab === target);
    });
    void render();
  });

  onConfigChange(() => { void render(); });
  onQuotaChange(() => { void render(); });

  void render();
  triggerRefresh().finally(() => { /* render is triggered by storage change */ });
  startLiveTicker();
}

function startLiveTicker() {
  clearInterval(livePulse);
  livePulse = setInterval(() => {
    DOMS.nowLabel.textContent = formatAbsolute(new Date());
    document.querySelectorAll("[data-countdown-ms]").forEach((node) => {
      const ms = Number(node.dataset.countdownMs);
      if (!Number.isFinite(ms)) return;
      const remaining = ms - Date.now();
      node.textContent = remaining > 0 ? formatDuration(remaining) : "now";
    });
  }, 30_000);
  DOMS.nowLabel.textContent = formatAbsolute(new Date());
}

async function render() {
  const [config, cache, history] = await Promise.all([
    loadConfig(),
    loadProviderQuotaCache(),
    loadProviderHistory()
  ]);

  const providers = enabledProviders(config);

  renderProviderHeroes(providers, cache, history, config);
  renderHeatmap(history, cache);

  if (cache.updatedAt) {
    DOMS.syncedLabel.textContent = `synced ${formatRelative(cache.updatedAt)}`;
  } else {
    DOMS.syncedLabel.textContent = "no sync yet";
  }
}

/* ----------------------------------------------------------- */
/*  Provider heroes                                            */
/* ----------------------------------------------------------- */

function renderProviderHeroes(providers, cache, history, config) {
  DOMS.providerGrid.replaceChildren();

  providers.forEach((provider) => {
    const quota = cache.providers[provider.id];
    const buckets = enrichedBuckets(provider, quota, history[provider.id] ?? {});
    const node = TEMPLATES.hero.content.firstElementChild.cloneNode(true);
    addClassIf(node, PROVIDER_THEME[provider.id]);
    const pinnedKey = config?.pinnedBucket?.[provider.id] ?? null;

    node.querySelector(".provider-mark").innerHTML = providerGlyphSvg(provider.id);

    const titleLink = node.querySelector(".panel-title");
    titleLink.textContent = provider.name;
    titleLink.href = provider.usageUrl ?? provider.appUrl ?? "#";
    titleLink.title = `Open ${provider.name} usage page`;

    const planText = quota?.plan ?? quota?.account?.plan ?? "";
    const emailText = quota?.account?.email ?? "";
    const accountPlanNode = node.querySelector(".phero-account-plan");
    const accountEmailNode = node.querySelector(".phero-account-email");
    const accountLinkNode = node.querySelector(".phero-account-link");
    accountPlanNode.textContent = planText;
    accountEmailNode.textContent = emailText || "—";
    accountLinkNode.href = provider.usageUrl ?? provider.appUrl ?? "#";
    accountLinkNode.textContent = `${provider.name.toLowerCase()} usage →`;

    const main = pickPrimary(buckets, pinnedKey);
    const status = node.querySelector(".status-dot");
    const statusText = node.querySelector(".status-text");
    let statusClass = "is-flat";
    let statusMessage = quota?.detail ?? "awaiting first sync";
    if (main) {
      if (main.utilization >= 80) { statusClass = "is-crit"; statusMessage = "critical · cap approaching"; }
      else if (main.utilization >= 60) { statusClass = "is-warn"; statusMessage = "approaching threshold"; }
      else if (main.utilization > 0) { statusClass = "is-good"; statusMessage = "within bounds"; }
      else { statusClass = "is-flat"; statusMessage = "idle"; }
    }
    addClassIf(status, statusClass);
    statusText.textContent = statusMessage;

    // per-provider sync timestamp + source
    const syncedNode = node.querySelector(".provider-synced");
    const sourceNode = node.querySelector(".provider-source");
    const observed = quota?._lastObservedAt ?? quota?.observedAt;
    if (observed) {
      syncedNode.textContent = `synced ${formatRelative(observed)}`;
      syncedNode.title = formatAbsolute(new Date(observed));
    } else {
      syncedNode.textContent = "no sync yet";
    }
    sourceNode.textContent = quota?.source ? `via ${quota.source}` : "no source";

    if (main) {
      node.querySelector(".phero-eyebrow-text").textContent = `PRIMARY · ${main.short ?? "WINDOW"}`;
      node.querySelector(".phero-name").textContent = main.label ?? provider.name;
      node.querySelector(".phero-sub").textContent = main.resetsAt
        ? `resets ${formatAbsolute(new Date(main.resetsAt))}`
        : "no scheduled reset";
      node.querySelector(".figure-value").textContent = formatNumber(main.remainingPercent ?? (100 - main.utilization), 0);
      node.querySelector(".bar-used").textContent = `USED · ${formatNumber(main.utilization, 1)}%`;
      node.querySelector(".bar-fill").style.width = `${Math.max(0, Math.min(100, main.utilization))}%`;

      const countdown = node.querySelector(".countdown-value");
      if (main.resetsAt) {
        const ms = new Date(main.resetsAt).getTime();
        countdown.dataset.countdownMs = String(ms);
        countdown.textContent = formatDuration(ms - Date.now());
      } else {
        countdown.textContent = "—";
      }

      const delta = node.querySelector(".delta-value");
      const pace = computePacePerHour(main.samples);
      delta.textContent = pace > 0 ? `+${pace.toFixed(1)}%/h`
        : pace < 0 ? `${pace.toFixed(1)}%/h`
        : "flat";
      delta.classList.remove("is-accent", "is-warn", "is-crit", "is-good");
      const deltaClass = pace > 5 ? "is-warn" : pace > 0 ? "is-accent" : "is-good";
      addClassIf(delta, deltaClass);

      drawSpark(node.querySelector(".phero-spark"), main, pace);

      node.querySelector(".window-value").textContent = main.windowLabel ?? "—";
      node.querySelector(".samples-value").textContent = String(main.samples?.length ?? 0);
      const projection = projectExhaustion(main.utilization, pace, main.resetsAt);
      node.querySelector(".projection-value").textContent = projection;
    }

    const restBody = node.querySelector(".rest-body");
    const rest = buckets.filter((bucket) => bucket !== main);
    if (rest.length === 0) {
      restBody.innerHTML = `<tr><td colspan="3" class="cell-meta" style="padding:18px;color:var(--ink-quiet);">No additional limits exposed.</td></tr>`;
    } else {
      for (const bucket of rest) {
        restBody.append(buildRestRow(bucket, provider.id));
      }
    }

    DOMS.providerGrid.append(node);
  });
}

function pickPrimary(buckets, pinnedKey) {
  if (!buckets || buckets.length === 0) return null;
  if (pinnedKey) {
    const pinned = buckets.find((bucket) => bucket.key === pinnedKey);
    if (pinned) return pinned;
  }
  // Default: the 5-hour window (matches the providers' own primary limit).
  return buckets.find((bucket) => bucket.windowSeconds === 18000)
    ?? buckets.find((bucket) => /five|5h|primary/i.test(bucket.label))
    ?? buckets[0];
}

function enrichedBuckets(provider, quota, providerHistory) {
  if (!quota?.buckets?.length) return [];
  return quota.buckets.map((bucket) => {
    const meta = BUCKET_LABEL_OVERRIDES[provider.id]?.[bucket.key] ?? {};
    const seconds = meta.windowSeconds ?? bucketWindowSeconds(bucket);
    const samples = providerHistory[bucket.key] ?? [];
    return {
      ...bucket,
      label: bucket.label || meta.name || bucket.key,
      short: meta.short ?? deriveShortFromLabel(bucket.label, bucket.key),
      windowSeconds: seconds,
      windowLabel: formatWindowLabel(seconds),
      samples
    };
  });
}

function bucketWindowSeconds(bucket) {
  // Codex bucket keys end with _<seconds>s.
  const match = /(\d+)s$/.exec(bucket.key ?? "");
  if (match) return Number(match[1]);
  if (bucket.resetsAt) {
    const remaining = new Date(bucket.resetsAt).getTime() - Date.now();
    if (remaining > 86_400_000 * 6) return 604_800;
    if (remaining > 3_600_000 * 4) return 18_000;
  }
  return 0;
}

function deriveShortFromLabel(label = "", key = "") {
  const text = (label || key).toUpperCase();
  if (text.includes("5H")) return "5H";
  if (text.includes("7D") || text.includes("WEEK")) return "7D";
  return text.split(/[\s·]/).slice(0, 2).join("·");
}

function formatWindowLabel(seconds) {
  if (!seconds) return "—";
  if (seconds >= 86_400) return `${Math.round(seconds / 86_400)}d`;
  if (seconds >= 3_600) return `${Math.round(seconds / 3_600)}h`;
  if (seconds >= 60) return `${Math.round(seconds / 60)}m`;
  return `${seconds}s`;
}

function buildRestRow(bucket, providerId) {
  const node = TEMPLATES.rest.content.firstElementChild.cloneNode(true);
  node.classList.add("is-clickable");
  node.title = `Pin "${bucket.label}" as the primary card for this provider`;
  node.tabIndex = 0;
  node.setAttribute("role", "button");
  const promote = () => pinBucket(providerId, bucket.key);
  node.addEventListener("click", promote);
  node.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); promote(); }
  });
  node.querySelector(".nm").textContent = bucket.label;
  node.querySelector(".id").textContent = `${bucket.short ?? bucket.key} · ${formatNumber(bucket.utilization, 1)}% used · ${formatNumber(bucket.remainingPercent, 1)}% left`;

  const fill = node.querySelector(".mini-bar-fill");
  fill.style.width = `${Math.max(0, Math.min(100, bucket.utilization))}%`;
  const sev = severity(bucket.utilization);
  addClassIf(fill, severityFillClass(sev));

  const pct = node.querySelector(".mini-pct");
  pct.textContent = `${formatNumber(bucket.utilization, 0)}%`;
  addClassIf(pct, severityPctClass(sev));

  const reset = node.querySelector(".reset-meta");
  if (bucket.resetsAt) {
    const date = new Date(bucket.resetsAt);
    reset.innerHTML = `${escapeHtml(formatAbsolute(date))}<br/><span class="muted">in ${escapeHtml(formatDuration(date.getTime() - Date.now()))}</span>`;
  } else {
    reset.textContent = "no reset";
  }

  return node;
}

function severity(utilization) {
  if (utilization >= 80) return "crit";
  if (utilization >= 60) return "warn";
  if (utilization > 0) return "active";
  return "flat";
}

/* ----------------------------------------------------------- */
/*  Burn projection sparkline                                  */
/* ----------------------------------------------------------- */

function drawSpark(svg, bucket, pace) {
  const VIEW_W = 780; // viewBox width (NOW marker sits at 520; 260px reserved for projection)
  const NOW_X = 520;
  const HEIGHT = 110;

  const samples = (bucket.samples ?? []).slice(-72);
  const points = sampleHistoryToPoints(samples, bucket.utilization);

  const linePath = points.length
    ? points.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ")
    : `M0 ${HEIGHT} L${NOW_X} ${HEIGHT - (bucket.utilization / 100) * HEIGHT}`;

  const lastY = points.length ? points[points.length - 1][1] : HEIGHT - (bucket.utilization / 100) * HEIGHT;
  const fillPath = `${linePath} L ${NOW_X} ${HEIGHT} L 0 ${HEIGHT} Z`;

  svg.querySelector(".spark-line").setAttribute("d", linePath);
  svg.querySelector(".spark-fill").setAttribute("d", fillPath);

  // Threshold lines at 50% and 80%
  const thresholds = svg.querySelector(".spark-thresholds");
  thresholds.innerHTML = "";
  for (const t of [50, 80]) {
    const y = HEIGHT - (t / 100) * HEIGHT;
    thresholds.insertAdjacentHTML("beforeend", `<line x1="0" y1="${y}" x2="${VIEW_W}" y2="${y}" stroke-width="1"/>`);
    thresholds.insertAdjacentHTML("beforeend", `<text x="${VIEW_W - 4}" y="${y - 4}" text-anchor="end">${t}%</text>`);
  }

  // Linear projection from current util + pace into the right-side panel.
  const projection = svg.querySelector(".spark-projection");
  if (Number.isFinite(pace) && Math.abs(pace) > 0.05) {
    const futureSpan = VIEW_W - NOW_X;
    const futureHours = 6;
    let projectionD = `M ${NOW_X} ${lastY}`;
    for (let step = 1; step <= 12; step += 1) {
      const t = step / 12;
      const utilFuture = Math.max(0, Math.min(100, bucket.utilization + pace * futureHours * t));
      const x = NOW_X + futureSpan * t;
      const y = HEIGHT - (utilFuture / 100) * HEIGHT;
      projectionD += ` L ${x.toFixed(1)} ${y.toFixed(1)}`;
    }
    projection.setAttribute("d", projectionD);
  } else {
    projection.setAttribute("d", `M ${NOW_X} ${lastY} L ${VIEW_W} ${lastY}`);
  }

  // NOW marker stays at NOW_X via template; nothing to do.
  svg.querySelector(".spark-now").setAttribute("x1", NOW_X);
  svg.querySelector(".spark-now").setAttribute("x2", NOW_X);
  svg.querySelector(".spark-now-label").setAttribute("x", NOW_X + 4);
}

function sampleHistoryToPoints(samples, currentUtil) {
  if (!samples || samples.length === 0) return [];
  const NOW_X = 520;
  const HEIGHT = 110;
  const last = samples[samples.length - 1];
  const lastMs = new Date(last.t).getTime();
  const sixHoursMs = 6 * 3_600_000;
  const startMs = lastMs - sixHoursMs;

  const points = [];
  for (const sample of samples) {
    const ms = new Date(sample.t).getTime();
    if (!Number.isFinite(ms) || ms < startMs) continue;
    const x = ((ms - startMs) / sixHoursMs) * NOW_X;
    const y = HEIGHT - (Math.max(0, Math.min(100, sample.u)) / 100) * HEIGHT;
    points.push([x, y]);
  }
  // Anchor the right edge to the present utilization.
  points.push([NOW_X, HEIGHT - (Math.max(0, Math.min(100, currentUtil)) / 100) * HEIGHT]);
  return points;
}

function computePacePerHour(samples) {
  if (!samples || samples.length < 2) return 0;
  const window = samples.slice(-12);
  const first = window[0];
  const last = window[window.length - 1];
  const elapsedHours = (new Date(last.t).getTime() - new Date(first.t).getTime()) / 3_600_000;
  if (!Number.isFinite(elapsedHours) || elapsedHours <= 0) return 0;
  return (last.u - first.u) / elapsedHours;
}

function projectExhaustion(util, pace, resetsAt) {
  if (pace <= 0.05) return util > 0 ? "flat — ample" : "idle";
  const remaining = Math.max(0, 100 - util);
  const hours = remaining / pace;
  if (resetsAt) {
    const resetMs = new Date(resetsAt).getTime() - Date.now();
    if (Number.isFinite(resetMs) && hours * 3_600_000 > resetMs) return "after reset";
  }
  if (hours <= 0) return "now";
  if (hours < 1) return `~${Math.round(hours * 60)}m`;
  if (hours < 24) return `~${hours.toFixed(1)}h`;
  return `~${(hours / 24).toFixed(1)}d`;
}

/* ----------------------------------------------------------- */
/*  Activity heatmap                                           */
/* ----------------------------------------------------------- */

function renderHeatmap(history, cache) {
  const days = 53 * 7;
  const today = startOfDay(new Date());
  const startOffset = today.getDay(); // align so the last column is the current week
  const startMs = today.getTime() - (days - 1 - startOffset) * 86_400_000;

  const claudeSeries = aggregateDailyMaxUtilization(history.claude ?? {}, startMs, days);
  const codexSeries  = aggregateDailyMaxUtilization(history.codex ?? {}, startMs, days);

  const eventsClaude = claudeSeries.filter((value) => value > 0).length;
  const eventsCodex  = codexSeries.filter((value) => value > 0).length;

  DOMS.activityTotals.textContent = `Claude ${eventsClaude} · Codex ${eventsCodex}`;
  DOMS.heatmapTotal.textContent = heatmapView === "claude"
    ? `Claude · ${eventsClaude} active days`
    : heatmapView === "codex"
      ? `Codex · ${eventsCodex} active days`
      : `${eventsClaude + eventsCodex} active days combined`;

  // Months row (12 evenly-spaced labels)
  const monthLabels = ["Jun","Jul","Aug","Sep","Oct","Nov","Dec","Jan","Feb","Mar","Apr","May"];
  DOMS.heatmapMonths.replaceChildren();
  monthLabels.forEach((label) => {
    const span = document.createElement("span");
    span.className = "heatmap-month";
    span.textContent = label;
    DOMS.heatmapMonths.append(span);
  });

  DOMS.heatmapGrid.replaceChildren();
  for (let i = 0; i < days; i += 1) {
    const cell = document.createElement("div");
    cell.className = "cell";
    const c = claudeSeries[i] ?? 0;
    const x = codexSeries[i] ?? 0;
    const cellDate = new Date(startMs + i * 86_400_000);
    const dateLabel = formatDateOnly(cellDate);

    if (heatmapView === "claude") {
      addClassIf(cell, "is-claude");
      cell.dataset.l = String(intensityLevel(c));
      cell.title = `${dateLabel} · Claude max ${c}%`;
    } else if (heatmapView === "codex") {
      addClassIf(cell, "is-codex");
      cell.dataset.l = String(intensityLevel(x));
      cell.title = `${dateLabel} · Codex max ${x}%`;
    } else {
      addClassIf(cell, "is-claude");
      addClassIf(cell, "is-dual");
      cell.dataset.l = String(intensityLevel(c));
      cell.title = `${dateLabel} · Claude ${c}% · Codex ${x}%`;
      const xLevel = intensityLevel(x);
      if (xLevel > 0) {
        const dot = document.createElement("span");
        dot.className = "codex-dot";
        dot.dataset.l = String(xLevel);
        cell.append(dot);
      }
    }
    DOMS.heatmapGrid.append(cell);
  }

  DOMS.heatmapLegend.replaceChildren();
  if (heatmapView === "both") {
    DOMS.heatmapLegend.innerHTML = `
      <span class="legend-pair"><span class="cell is-claude" data-l="3"></span><span class="legend-key">fill · Claude</span></span>
      <span class="legend-pair"><span class="cell is-claude is-dual" data-l="1"><span class="codex-dot" data-l="4"></span></span><span class="legend-key">dot · Codex</span></span>
      <span class="legend-key dim">intensity 0–4</span>
    `;
  } else {
    const cls = heatmapView === "codex" ? "is-codex" : "is-claude";
    DOMS.heatmapLegend.innerHTML = `
      <span>less</span>
      <span class="cells">
        <span class="cell ${cls}" data-l="0"></span>
        <span class="cell ${cls}" data-l="1"></span>
        <span class="cell ${cls}" data-l="2"></span>
        <span class="cell ${cls}" data-l="3"></span>
        <span class="cell ${cls}" data-l="4"></span>
      </span>
      <span>more</span>
    `;
  }

  // Suppress unused warning for cache parameter
  void cache;
}

function aggregateDailyMaxUtilization(providerHistory, startMs, days) {
  const series = new Array(days).fill(0);
  for (const samples of Object.values(providerHistory)) {
    for (const sample of samples) {
      const ms = new Date(sample.t).getTime();
      if (!Number.isFinite(ms) || ms < startMs) continue;
      const dayIndex = Math.floor((ms - startMs) / 86_400_000);
      if (dayIndex < 0 || dayIndex >= days) continue;
      if (sample.u > series[dayIndex]) series[dayIndex] = sample.u;
    }
  }
  return series;
}

function intensityLevel(utilization) {
  if (utilization <= 0) return 0;
  if (utilization < 25) return 1;
  if (utilization < 50) return 2;
  if (utilization < 80) return 3;
  return 4;
}

function startOfDay(date) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

/* ----------------------------------------------------------- */
/*  Refresh orchestration                                      */
/* ----------------------------------------------------------- */

async function triggerRefresh({ force = false } = {}) {
  if (inFlightRefresh) return inFlightRefresh;

  inFlightRefresh = (async () => {
    const [config, cache] = await Promise.all([loadConfig(), loadProviderQuotaCache()]);
    const providers = enabledProviders(config);
    const ttlMs = Math.max(Number(config.refreshMinutes) || 5, 1) * 60 * 1000;

    await Promise.all(providers.map(async (provider) => {
      const quota = cache.providers[provider.id];
      if (!force && isFresh(quota, ttlMs)) return;

      try {
        const runtime = await loadProviderRuntime(provider.id);
        const result = provider.id === "claude"
          ? await fetchClaudeUsage({ runtime })
          : await fetchCodexUsage({ runtime });
        if (result.runtime) await saveProviderRuntime(provider.id, result.runtime);
        if (result.quota) await saveProviderQuota(provider.id, result.quota, result.rawPayload);
      } catch (error) {
        console.warn(`[tokenxiety] ${provider.id} refresh failed`, error);
      }
    }));
  })();

  try {
    await inFlightRefresh;
  } finally {
    inFlightRefresh = null;
    // BroadcastChannel doesn't deliver to its own context, so render explicitly
    // here. Other tabs/windows get notified via the channel and render via
    // onQuotaChange().
    void render();
  }
}

function isFresh(quota, ttlMs) {
  if (!quota || quota.status !== "ready") return false;
  const observedAt = quota._lastObservedAt ?? quota.observedAt;
  if (!observedAt) return false;
  const ms = new Date(observedAt).getTime();
  if (!Number.isFinite(ms)) return false;
  return Date.now() - ms < ttlMs;
}

/* ----------------------------------------------------------- */
/*  Formatters                                                 */
/* ----------------------------------------------------------- */

function formatNumber(value, decimals = 0) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return new Intl.NumberFormat(undefined, { minimumFractionDigits: 0, maximumFractionDigits: decimals }).format(value);
}

function formatRelative(value) {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const absolute = Math.abs(seconds);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (absolute < 60) return formatter.format(seconds, "second");
  if (absolute < 3600) return formatter.format(Math.round(seconds / 60), "minute");
  if (absolute < 86_400) return formatter.format(Math.round(seconds / 3600), "hour");
  return formatter.format(Math.round(seconds / 86_400), "day");
}

function formatAbsolute(date) {
  if (!date) return "—";
  const days = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const h = date.getHours();
  const ampm = h >= 12 ? "pm" : "am";
  const h12 = ((h + 11) % 12) + 1;
  const pad = (n) => String(n).padStart(2, "0");
  return `${days[date.getDay()]} ${months[date.getMonth()]} ${date.getDate()}, ${h12}:${pad(date.getMinutes())}${ampm}`;
}

function formatDateOnly(date) {
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${months[date.getMonth()]} ${date.getDate()}`;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const totalMin = Math.round(ms / 60_000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  const pad = (n) => String(n).padStart(2, "0");
  if (d > 0) return `${d}d ${pad(h)}h ${pad(m)}m`;
  return `${pad(h)}h ${pad(m)}m`;
}

function addClassIf(node, className) {
  if (!node || !className) return;
  node.classList.add(className);
}

async function pinBucket(providerId, bucketKey) {
  const config = await loadConfig();
  config.pinnedBucket = config.pinnedBucket ?? { claude: null, codex: null };
  // Toggle: clicking the already-pinned bucket clears the pin (back to default).
  config.pinnedBucket[providerId] = config.pinnedBucket[providerId] === bucketKey ? null : bucketKey;
  await saveConfig(config);
  void render();
}

function providerGlyphSvg(providerId) {
  // Pixel-art glyphs from the designer mock, inlined as SVG. currentColor =
  // provider tint; eyes are punched out with the panel background.
  if (providerId === "claude") {
    const body = [
      [1,1],[2,1],[3,1],[4,1],[5,1],[6,1],[7,1],
      [1,2],[3,2],[4,2],[5,2],[7,2],
      [0,3],[1,3],[2,3],[3,3],[4,3],[5,3],[6,3],[7,3],[8,3],
      [0,4],[1,4],[2,4],[3,4],[4,4],[5,4],[6,4],[7,4],[8,4],
      [1,5],[2,5],[3,5],[4,5],[5,5],[6,5],[7,5],
      [1,6],[3,6],[5,6],[7,6],
      [1,7],[3,7],[5,7],[7,7]
    ];
    const eyes = [[2,2],[6,2]];
    return pixelSvg(body, eyes, 9, 9);
  }
  // Codex — pixel X
  const body = [
    [1,1],[7,1],[2,2],[6,2],[3,3],[5,3],[4,4],[3,5],[5,5],[2,6],[6,6],[1,7],[7,7]
  ];
  return pixelSvg(body, [], 9, 9);
}

function pixelSvg(body, eyes, cols, rows) {
  const rect = ([x, y]) => `<rect x="${x}" y="${y}" width="1.02" height="1.02" fill="currentColor"/>`;
  const eye = ([x, y]) => `<rect x="${x}" y="${y}" width="1.02" height="1.02" fill="var(--bg-1)"/>`;
  return `<svg class="prov-glyph" viewBox="0 0 ${cols} ${rows}" shape-rendering="crispEdges" aria-hidden="true">${body.map(rect).join("")}${eyes.map(eye).join("")}</svg>`;
}

function severityFillClass(sev) {
  if (sev === "crit") return "is-crit";
  if (sev === "warn") return "is-warn";
  if (sev === "flat") return "is-good";
  return null;
}

function severityPctClass(sev) {
  if (sev === "crit") return "is-crit";
  if (sev === "warn") return "is-warn";
  if (sev === "flat") return "is-quiet";
  return null;
}

function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  }[char] ?? char));
}
