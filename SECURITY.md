# Security and privacy model

## Data collected

Tokenxiety stores only sanitized quota metadata in extension-local storage:

- provider id
- remaining / used / limit counts when detected
- reset time when detected
- source (`network` or `dom`)
- confidence score
- observation timestamp
- short non-sensitive detection detail

## Data intentionally not stored

- cookies
- session tokens
- API keys
- prompts
- conversations
- raw DOM text
- raw network responses
- arbitrary endpoint configuration

## Permission boundary

Host access is limited to:

- `https://claude.ai/*`
- `https://chatgpt.com/*`
- `https://chat.openai.com/*`

The extension does not request `<all_urls>` and does not accept user-entered fetch URLs.

## Provider interaction

Tokenxiety relies on the user's existing browser login. It observes quota-shaped signals already delivered to provider web apps. It does not modify requests, request bodies, headers, responses, cookies, or page state.

## Threat model decisions

- Prefer no API-key input over storing long-lived provider secrets.
- Prefer bounded host permissions over generic endpoint support.
- Prefer sanitized local cache over background syncing.
- Prefer graceful stale/unknown states over guessing quota from unrelated text.
