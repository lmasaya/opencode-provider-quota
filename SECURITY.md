# Security Policy

Report vulnerabilities privately to the repository owner. Do not include credentials, OAuth tokens, or raw provider responses in an issue.

Security invariants:

- Only `chatgpt.com` and `api.github.com` are valid quota hosts.
- Provider endpoints are constants, never configuration.
- Redirects are rejected.
- OAuth tokens are obtained through OpenCode's integration API, stay in the server process, and are never logged, persisted, sent to the TUI, or refreshed by this plugin.
- The plugin does not read `auth.json` or the OpenCode database.
- The plugin must not load configuration from a worktree or `.opencode` directory.

## Dependency Note

Development dependencies include OpenTUI (`@opentui/*`), which OpenCode provides to plugins at runtime. Run `npm audit` before each release; it was clean at 2.0.0. Do not force fixes that downgrade OpenTUI below OpenCode's required version.
