# Tokenxiety

New tab dashboard for Claude (and Codex / ChatGPT) usage limits.

The new tab page calls each provider with the cookies in your existing browser session, parses the utilization buckets, and renders a GitHub‑style dashboard with per‑bucket meters, sparklines, and reset countdowns.

## What it shows

For Claude it calls `https://claude.ai/api/organizations/<org>/usage` and renders every non-null bucket:

- 5-hour window
- 7-day total
- 7-day Sonnet
- 7-day Opus
- 7-day Claude Code
- Top-up credits when enabled

The big number on each card is the remaining percent of the most-constrained bucket — that is the one that limits you next.

## Why no API key

Claude and ChatGPT do not expose a stable public quota API. Tokenxiety reuses the cookies in your browser. No tokens, no API keys, no settings to copy around.

## Privacy

- Host access is restricted to `claude.ai`, `chatgpt.com`, `chat.openai.com`.
- Only sanitized utilization numbers are stored locally.
- Raw responses, prompts, conversations, cookies, and tokens are not stored.
- The extension only reads the `lastActiveOrg` cookie via `chrome.cookies` to discover the active Claude org id.

## Build

```bash
npm run validate
npm run build
```

`dist/tokenxiety` and `dist/tokenxiety.zip` are produced. The legacy directory `dist/tokenxiety-quota-tab` is mirrored for older `--load-extension` flags.

## Install in Chromium / Chrome (development)

1. `npm run build`
2. Open `chrome://extensions`
3. Enable Developer mode
4. Click **Load unpacked** and pick `dist/tokenxiety`
5. Open a new tab; the dashboard loads and triggers a refresh
6. To reload after code changes, click the reload icon next to Tokenxiety on `chrome://extensions`

If the extension is already loaded via `--load-extension`, just rerun `npm run build` and click the reload icon. No browser restart required.

## Refresh model

- Background service worker fetches every `refreshMinutes` (default 5) via `chrome.alarms`.
- Each new tab open also triggers a refresh.
- The Settings page exposes a manual **Refresh now** button.

## Files

- `manifest.json`
- `src/background.js` — service worker entrypoint
- `src/background-claude.js` — calls the Claude usage API
- `src/background-codex.js` — best-effort ChatGPT/Codex calls
- `src/background-storage.js` — service-worker storage helpers
- `src/quota-extractors.js` — pure parsers (covered by tests)
- `src/storage.js` — UI-side storage helpers
- `src/quota.js` — provider catalog + display state derivation
- `src/newtab.{html,css,js}` — dashboard
- `src/options.{html,css,js}` — settings
- `test/quota-extractors.test.mjs` — extractor unit tests
