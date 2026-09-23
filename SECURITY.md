# Security Policy

Report vulnerabilities privately to the repository owner. Do not include credentials, OAuth tokens, or raw provider responses in an issue.

Security invariants:

- Only `chatgpt.com`, `api.github.com`, and `api.anthropic.com` are valid quota hosts.
- Provider endpoints are constants, never configuration.
- Redirects are rejected.
- OAuth tokens are read in memory and never logged, persisted, or refreshed by this plugin.
- The plugin must not load configuration from a worktree or `.opencode` directory.

## Dependency Note

OpenCode currently requires `@opentui/solid >=0.4.5`. The compatible TUI chain has a low-severity `@babel/core` source-map advisory. The available npm audit fix downgrades OpenTUI below OpenCode's required version, so it must not be forced. Reassess this when OpenCode updates its TUI peer dependency.
