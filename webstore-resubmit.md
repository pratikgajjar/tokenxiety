# Chrome Web Store re-submission package — v0.32.0

## 1. Listing fields to update

### Item name (max 75 chars)
```
Tokenxiety — Unofficial AI Usage Monitor
```

### Summary (max 132 chars)
```
Unofficial new tab dashboard for your own AI chat rate-limit usage. Reads your existing session. Local storage only. No telemetry.
```

### Category
```
Productivity
```

### Description (full)
```
Tokenxiety is an INDEPENDENT, OPEN-SOURCE new tab dashboard. It is NOT
affiliated with, endorsed by, or sponsored by Anthropic, OpenAI, or any
other AI service provider. "Claude" is a trademark of Anthropic.
"ChatGPT" and "Codex" are trademarks of OpenAI. Those names are used
here solely to describe interoperability — what services this tool
reads when you are already signed in on them — under nominative fair
use.

WHAT IT DOES

Tokenxiety reads your OWN rate-limit data from the AI chat services
you are already signed in to and displays it on your new tab page so
you can see, at a glance:

  * how close you are to your 5-hour and 7-day caps
  * when each cap resets
  * a burn-projection sparkline based on your own observed usage
  * a per-bucket breakdown (one row per limit your account exposes)

PRIVACY

  * All data is stored LOCALLY in IndexedDB in your browser.
  * Nothing is ever sent to any server we control.
  * No analytics, no telemetry, no third-party network calls.
  * Source code is publicly auditable on GitHub.

HOW IT WORKS

When you open a new tab, Tokenxiety reuses the cookies in your own
browser session (via the requested host_permissions on claude.ai and
chatgpt.com) to call each service's own rate-limit endpoint. The
response is parsed into a small set of utilization numbers and
rendered. No API key, no sign-in, no configuration required.

OPEN SOURCE

MIT-licensed. Source: https://github.com/pratikgajjar/tokenxiety
Privacy policy: https://github.com/pratikgajjar/tokenxiety/blob/main/PRIVACY.md

NOT AFFILIATED with Anthropic, OpenAI, Google, or any other
third party.
```

### Permission justifications

**`storage`**
```
Stores the user's local cache of utilization snapshots, a per-provider
hash-diff layer, and the user's choice of which rate-limit bucket to
pin as the primary card. Required for the extension to remember state
between new tab opens. Data is stored in IndexedDB in the user's own
browser; nothing is uploaded anywhere.
```

**`alarms`**
```
Schedules a once-per-minute background refresh of the user's
rate-limit data so the new tab dashboard is up to date when opened.
This is the lowest-impact way to keep the data current without
blocking the new tab render.
```

**Host permission — `https://claude.ai/*`**
```
Required to call claude.ai's own /api/organizations/<id>/usage
endpoint using the user's existing session cookies. This is what
the user already sees when they visit claude.ai/settings/usage —
we just render it on the new tab. No other resources on claude.ai
are read or modified.
```

**Host permission — `https://chatgpt.com/*` and `https://chat.openai.com/*`**
```
Required to call ChatGPT's own /backend-api/wham/usage endpoint
using the user's existing session cookies and to obtain the session
bearer token from /api/auth/session. This is the same usage data
ChatGPT displays to the user in its own UI. No other resources are
read or modified.
```

### Single purpose
```
Display the signed-in user's own rate-limit usage from supported AI
chat services on the Chrome new tab page.
```

### Data usage declarations

Check ONLY:
  * Authentication information — to read your own usage limits
  * Web history — NOT collected
  * User activity — NOT collected
  * Personally identifiable information — only the email each service
    itself returns from its own usage endpoint, and only to display
    it locally on your dashboard

Affirmative statements:
  * I do not sell user data to third parties.
  * I do not use or transfer user data for purposes unrelated to my
    item's single purpose.
  * I do not use or transfer user data to determine creditworthiness
    or for lending purposes.

Privacy policy URL:
```
https://github.com/pratikgajjar/tokenxiety/blob/main/PRIVACY.md
```

---

## 2. Appeal text (paste into the appeal form when re-submitting)

```
Thank you for the review. We received a Program Policies violation
notice. We have re-read the policy pages and believe the prior
listing read as if Tokenxiety were an official product of Anthropic
or OpenAI, which would violate Impersonation & Intellectual Property
clause 5 (trademark). That was not our intent and we have corrected
it.

The product itself is an open-source dashboard that reads only the
signed-in user's own rate-limit data via the services' own
publicly-served endpoints from inside the user's own browser. It
does not impersonate, redistribute, or interfere with either service.

What we changed in v0.32.0:

  1. Renamed the listing item to
     "Tokenxiety — Unofficial AI Usage Monitor"
     and updated the extension's manifest name and action title to
     match.

  2. Rewrote the description and summary to lead with a clear,
     prominent disclaimer that Tokenxiety is independent, not
     affiliated with Anthropic or OpenAI, and that any use of their
     trademarks is strictly nominative fair use for interoperability
     description.

  3. Updated README.md and PRIVACY.md on the public source
     repository with the same disclaimers.

  4. Reviewed the screenshots — no third-party logos are used.
     Brand colors used on the screenshots are generic UI accents and
     have been adjusted where they could read as trade dress.

Permissions remain minimal:
  * storage, alarms
  * host_permissions only on claude.ai, chatgpt.com, chat.openai.com,
    used solely to read the user's own usage from each service's own
    endpoint with the user's existing session cookies. No other URLs
    are fetched. Nothing is uploaded anywhere — all storage is local
    in IndexedDB.

Source code is fully open under MIT at
https://github.com/pratikgajjar/tokenxiety
and the public release is at
https://github.com/pratikgajjar/tokenxiety/releases/tag/v0.32.0

We respectfully request reinstatement.
```
