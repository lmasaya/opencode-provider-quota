# OpenCode Quota

A local-first OpenCode quota sidebar for OpenAI, GitHub Copilot, and Claude.

## Sidebar

Each provider card shows:

- Remaining percentage for the current subscription windows.
- Reset time, expressed relatively while it is near.
- A safe unavailable/error state when quota data is not supplied.
- A clear source label: these are unofficial subscription endpoints, not API billing or API rate-limit data.

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
npm ci --ignore-scripts
npm run build
npm run check
npm test
mise exec -- npm run test:ui
```

The UI regression test uses Bun (pinned in `mise.toml`) and OpenTUI's real
test renderer against `dist/tui.js`. It supplies synthetic credentials and
mocked provider responses, verifies delayed cards and percentage bars, checks
refreshes do not duplicate cards, and checks timer cleanup. Run `mise install`
first to provision the test runtime.

## Installation

The chezmoi-managed OpenCode configuration installs a pinned GitHub release to `~/.local/share/opencode/plugins/opencode-quota`. It uses mise's managed Node runtime and `npm ci --omit=dev --ignore-scripts` to install only the lockfile-pinned runtime dependencies.
