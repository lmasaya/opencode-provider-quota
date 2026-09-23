# OpenCode Quota

A local-first OpenCode quota sidebar for OpenAI, GitHub Copilot, and Claude.

## Sidebar

Each provider card shows:

- Remaining percentage for the current subscription windows.
- Reset time, expressed relatively while it is near.
- A safe unavailable/error state when quota data is not supplied.
- A clear source label: these are unofficial subscription endpoints, not API billing or API rate-limit data.

`opencode-token-usage` remains responsible for local session token and cost totals, avoiding duplicate state and storage.

## Security Model

- Reads only the matching OAuth entry from OpenCode's global `auth.json`.
- Has no repository-local configuration, shell execution, telemetry, persistence, dependency updates, or provider URL overrides.
- Sends each credential only to its fixed HTTPS provider endpoint.
- Rejects redirects, uses a 10-second deadline, caps responses at 64 KiB, and keeps quota results only in memory.
- Polls each provider at most once per minute and coalesces concurrent requests.
- Does not refresh or write OAuth credentials. Reauthenticate with OpenCode when a token expires.

OpenAI and Copilot use unofficial subscription endpoints that can change without notice. Claude's subscription endpoint is disabled by default because OpenCode documents policy concerns around Claude Pro/Max integrations. Set `OPENCODE_QUOTA_ENABLE_ANTHROPIC=1` only if you accept that risk.

## Development

```sh
npm install
npm run check
npm test
```

This repository intentionally stays private until the implementation and provider contracts receive another review.
