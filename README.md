# Tokenxiety

New tab dashboard for **Claude** and **Codex / ChatGPT** usage limits.

The new tab calls each provider's own usage API with the cookies in your existing browser session, parses the utilization buckets, and renders a tactical dashboard with per-bucket meters, burn-projection sparklines, reset countdowns, and an activity heatmap built from your real polling history.

## What it shows

**Claude** — `GET https://claude.ai/api/organizations/<org>/usage`
- Current session (5-hour window)
- All models / Sonnet only / Opus only / Claude Design / Co-work / OAuth apps (7-day windows)
- Top-up credits when enabled

**Codex / ChatGPT** — `GET https://chatgpt.com/backend-api/wham/usage`
- Primary 5-hour window, secondary 7-day window
- Each `additional_rate_limits` feature (e.g. `GPT-5.3-Codex-Spark`)
- Credits balance when enabled

The big number on each card is the **remaining percent of the most-constrained bucket** — the one that will throttle you first.

## Why no API key

Claude and ChatGPT do not expose a stable public quota API. Tokenxiety reuses the cookies in your browser via `host_permissions` for those domains. No tokens, no API keys, no settings to copy around.

## Privacy

- Host access is restricted to `claude.ai`, `chatgpt.com`, `chat.openai.com`. Nothing else.
- Only sanitized utilization numbers, plan name, and the email each provider exposes on its own usage endpoint are stored.
- All storage is **local** in IndexedDB. No server, no telemetry, no analytics.
- See [`PRIVACY.md`](./PRIVACY.md) for the full data inventory and permission justifications.

## Build

```bash
npm run validate     # manifest + JS syntax + tests
npm run build        # → dist/tokenxiety/  and  dist/tokenxiety.zip
```

## Install in Chromium / Chrome (development)

1. `npm run build`
2. Open `chrome://extensions`
3. Enable **Developer mode**
4. Click **Load unpacked** and pick `dist/tokenxiety`
5. Open a new tab — the dashboard loads and triggers a refresh
6. After code changes, click the reload icon on the Tokenxiety card. No browser restart needed.

## Refresh model

- Background service worker (`src/background.js`) polls every `refreshMinutes` (default 1 in dev / 5 in prod) via `chrome.alarms`. History accumulates in IndexedDB even when no tab is open.
- Opening a new tab also triggers a refresh, respecting the same TTL.
- The masthead **REFRESH** link force-refreshes (bypasses TTL).

## Architecture

- Vanilla ES modules. No bundler, no framework. Strict CSP `script-src 'self'`.
- IndexedDB schema v3:
  - `quota_latest` keyPath: `providerId`
  - `snapshot` keyPath: `[providerId, ts]` — raw API payload, replayable
  - `bucket_sample` keyPath: `[providerId, bucketKey, ts]` — time-series
  - SHA-256 hash diff before write — only meaningful changes touch disk.
- Direct fetch is primary (visible in new tab Network tab). For Claude we send `anthropic-client-platform: web_claude_ai` and probe every org returned by `/api/organizations` until one responds 200. For Codex we obtain a Bearer token from `/api/auth/session` and call `/backend-api/wham/usage`.
- Same-origin fallback via content-script relay (`src/content-relay.js`) on claude.ai / chatgpt.com tabs if the cross-origin path is ever blocked.

## Files

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest |
| `src/background.js` | Service-worker cron (chrome.alarms) |
| `src/providers.js` | Claude + Codex fetchers (direct + relay) |
| `src/extractors.js` | Pure parsers (unit-tested) |
| `src/db.js` | IndexedDB layer with hash-diff writes |
| `src/storage.js` | High-level storage facade + sanitizers |
| `src/quota.js` | Provider catalog + display-state derivation |
| `src/content-relay.js` | Same-origin fetch relay on provider pages |
| `src/newtab.{html,css,js}` | Dashboard UI |
| `src/options.{html,css,js}` | Settings UI |
| `src/assets/fonts/*.woff2` | Departure Mono + JetBrains Mono (bundled) |
| `src/assets/icons/*.png` | 16/48/128 px Web Store icons |
| `test/quota-extractors.test.mjs` | Extractor unit tests |

## License

MIT — see [`LICENSE`](./LICENSE). Copyright © 2026 **pg@backend.how**.
