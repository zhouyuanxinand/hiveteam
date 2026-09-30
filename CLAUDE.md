# CLAUDE.md

This file gives AI coding tools public-safe project context for HiveTeam. It stays
brief by design: unpublished implementation plans and product strategy are not
published in this repository.

## What HiveTeam Is

HiveTeam is a browser-native workbench for coordinating multiple local CLI agents.
Users create a workspace, start one Orchestrator agent, add worker agents, and
let them communicate through HiveTeam's injected `team` protocol.

Key properties:

- Agents are real local PTY processes such as Claude Code, Codex, OpenCode,
  Gemini, or custom commands.
- The web UI talks to a local Node runtime over HTTP and WebSocket on
  `127.0.0.1`.
- Workspace metadata is stored locally in SQLite.
- Workspace task state lives in `<workspace>/.hive/tasks.md`.
- `team send`, `team report`, `team status`, and related commands are only
  injected into HiveTeam-managed agent sessions.

## Public Development Source Of Truth

For public work, use these files as the source of truth:

1. `README.md` / `README.en.md` for user-facing behavior.
2. `AGENTS.md` for coding and review constraints.
3. Existing code and tests for implementation details.
4. GitHub issues and PR discussion for scoped changes.

If behavior is unclear, ask in an issue or PR before inventing protocol changes.

## Engineering Rules

- Keep protocol payloads stable and use snake_case on HTTP/JSON boundaries.
- Preserve the agent state model: `idle`, `working`, `stopped`.
- Do not add production fallbacks only to make tests pass.
- Prefer real integration coverage for HTTP, SQLite, and PTY behavior.
- Avoid broad refactors unless they directly support the change being made.

For the full local coding rules, read `AGENTS.md`.
