# AGENTS.md

Public coding rules for AI-assisted work in this repository.

HiveTeam's unpublished implementation plans and product strategy are not published
here. For public contributions, use the current code, README, tests, and issue
discussion as the source of truth. If behavior is unclear, ask before changing
protocol semantics.

## Hard Bans

### No test-only production fallbacks

Do not add production branches just to make a test easier to run. Mock or isolate
test dependencies in tests; keep production code on the real runtime path.

### No broad exception swallowing

Do not catch errors and match strings to hide root causes. Fix the cause or use
typed errors / explicit error codes.

### No fake tests

Avoid tests that only prove a mock was called, `expect(true).toBe(true)`,
source-string assertions, or `not.toThrow()` without checking behavior. A test
must fail when the production behavior is wrong.

### No weak generated IDs

Use `crypto.randomUUID()` for IDs. Do not use `Math.random().toString(36)`.

### No memory-before-database writes

When state is persisted, write to SQLite first and update in-memory state only
after persistence succeeds, or wrap the full change in a transaction.

## Required Practices

### Preserve public protocol contracts

HTTP and JSON payloads use snake_case at the boundary. TypeScript internals may
use camelCase, but serialization must keep the public shape stable.

### Preserve the agent state model

Agent status is `idle`, `working`, or `stopped`. PTY exit paths must update the
agent summary to `stopped`; dispatch/report/cancel paths must keep pending work
and visible status consistent.

### Use real integration coverage for runtime behavior

Changes involving HTTP routes, SQLite state, PTYs, terminal websockets, or the
`team` CLI need integration coverage that crosses the real boundary. Pure logic
can stay in `tests/unit`.

### Keep files focused

Avoid growing catch-all files. If a route, store, or component becomes hard to
scan, split it before adding unrelated behavior.

### Keep commits clean

Do not include AI-tool attribution in commits, PR bodies, or comments. Use a
normal human commit message that explains the change.

## Verification

Before submitting a non-trivial change, run:

```bash
pnpm check
pnpm build
pnpm test
```

If you skip a command, say exactly why.
