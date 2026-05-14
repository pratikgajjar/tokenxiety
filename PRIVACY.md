# Tokenxiety — Privacy Policy

_Last updated: 2026-05-13_

## Independent project — no affiliation

Tokenxiety is an independent open-source project. It is **not** affiliated
with, endorsed by, or sponsored by Anthropic, OpenAI, or any other AI service
provider. "Claude" is a trademark of Anthropic. "ChatGPT" and "Codex" are
trademarks of OpenAI. Those names appear in this document only to identify the
third-party services Tokenxiety interoperates with — strictly under nominative
fair use.

## Summary

Tokenxiety is a browser extension that displays your **own** usage limits from
the AI chat services you are signed in to, on your new tab page. It does not
send any of your data to a server we control. Everything is processed and
stored locally in your browser.

## What we access

Tokenxiety is granted **host permissions** for these origins only:

- `https://claude.ai/*`
- `https://chatgpt.com/*`
- `https://chat.openai.com/*`

When you open a new tab, or every few minutes via a background alarm, the
extension makes the same authenticated calls your browser already makes when
you visit the providers' usage pages:

- `GET https://claude.ai/api/organizations` and `…/api/organizations/<org>/usage`
- `GET https://chatgpt.com/api/auth/session` and `…/backend-api/wham/usage`

These requests use the cookies your browser already holds for those domains.
The extension never sees, copies, transmits, or stores those cookies.

## What we store (locally only)

In your browser's local IndexedDB (`tokenxiety` database) we keep:

1. **Latest quota record** per provider — utilization percent, remaining
   percent, reset timestamps, plan name, and the email the provider exposes
   on its `/usage` endpoint.
2. **Raw API response snapshots** — the JSON returned by the provider, so
   the dashboard can re-render historical states without re-fetching.
3. **Bucket samples** — a time-series of utilization values (number per
   bucket per minute) used to draw sparklines and the activity heatmap.

We do **not** store: cookies, session tokens, bearer tokens, prompts,
conversations, message contents, or any content of provider responses other
than the usage fields listed above.

## What we send to third parties

Only the requests listed under "What we access". Those go directly from your
browser to Anthropic / OpenAI — exactly as if you visited their usage page
yourself.

We **do not** send data to any server operated by Tokenxiety. There are no
analytics, no error reporting services, no remote configuration calls.

## Permissions justification

| Permission | Why |
|---|---|
| `storage` | Persist your refresh interval and provider toggles. |
| `alarms` | Trigger the background poll every N minutes so history accumulates when no new tab is open. |
| `host_permissions` (claude.ai, chatgpt.com, chat.openai.com) | Make the usage API calls and inject the same-origin fallback content script for those pages. |

## Your data, your machine

To wipe everything Tokenxiety has stored:

- Open the extension's Settings page → **Clear cache**, or
- Remove the extension from `chrome://extensions`. All IndexedDB data in the
  `tokenxiety` database is deleted with it.

## Contact

Tokenxiety is open source under the MIT License.

- Owner: **pg@backend.how**
- License: see `LICENSE` in the source repository
- Issues / questions: please email the owner above
