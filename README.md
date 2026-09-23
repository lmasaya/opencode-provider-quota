# OpenCode Quota

A local-first OpenCode quota sidebar for OpenAI, GitHub Copilot, and Claude.

## Sidebar

Each provider card shows:

- Remaining percentage for the current subscription windows.
- Reset time, expressed relatively while it is near.
- A safe unavailable/error state when quota data is not supplied.
- A clear source label: these are unofficial subscription endpoints, not API billing or API rate-limit data.

### OpenAI quota sources

OpenAI reports quota differently per plan, so both shapes are read:

- Consumer/Codex plans expose `rate_limit.primary_window` and `secondary_window`
  as 5h and weekly windows.
- Business/enterprise plans leave those null and instead expose a credit budget
  under `spend_control.individual_limit`. That budget renders as the bar, with
  the absolute balance shown beneath it.

Timestamps from OpenAI are epoch seconds. Percentages from all providers are
read on a 0-100 scale and never rescaled, so a 1% remainder is never mistaken
for a full quota.

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

## Releasing

```sh
npm run package
```

This builds `dist/` and produces `opencode-quota-v<version>.tar.gz` plus a
`.sha256` digest. Attach both to the GitHub release, then pin the version and
digest in the chezmoi install script.

## Installation

The chezmoi-managed OpenCode configuration installs a pinned GitHub release to
`~/.local/share/opencode/plugins/opencode-quota`.

The deployed artifact is only `package.json` and `dist/` — roughly 8 KB with no
`node_modules`. OpenCode embeds `@opentui/*` and `solid-js` in its own binary
and provides them to plugins, so they are declared as optional peer
dependencies rather than vendored. Nothing is compiled or installed on the
target machine, and no package manager runs at deploy time.

The install script verifies the release archive against a pinned SHA-256 digest
before extracting, and swaps the directory atomically so a failed download
cannot leave a partially written plugin in place.

