<p align="center">
  <img src="./assets/logo.png" width="120" alt="HiveTeam logo" />
</p>

# HiveTeam

<p align="center">
  <img src="./assets/hive-hero.png" alt="HiveTeam local-first multi-agent collaboration workspace hero image" />
</p>

**Run Claude Code, Codex, Gemini, OpenCode, Qwen, and other CLI agents as a visible local team.** HiveTeam gives you one browser workbench where an
Orchestrator plans and delegates while workers implement, review, test,
research, and report back — all as real PTY processes on your laptop.

Use HiveTeam when one agent is not enough, but a pile of terminal windows is not a workflow.

[![ci](https://img.shields.io/github/actions/workflow/status/zhouyuanxinand/hiveteam/release.yml?branch=main&label=ci)](https://github.com/zhouyuanxinand/hiveteam/actions/workflows/release.yml)
[![Node](https://img.shields.io/badge/node-22.18%2B%20%2822.x%29%20%7C%2024.x-3c873a.svg)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-BUSL--1.1-orange.svg)](./LICENSE.BSL)
[![Platforms](https://img.shields.io/badge/platforms-macOS%20%C2%B7%20Linux%20%C2%B7%20Windows%20(best--effort)-lightgrey.svg)](#platform-support)

English · [简体中文](./README.zh.md)

> This repository is a source-controlled, self-hosted HiveTeam fork. It runs on
> `127.0.0.1` by default and does not query npm or the original Hive release
> channel for updates.
>
> Build and update it from this repository so the running code always matches
> the commit you selected.

<p align="center">
  <img src="./assets/hive-team-view.png" alt="Hive workbench with a 4-agent team — orchestrator dispatching while workers run" />
</p>

## Why HiveTeam

CLI agents are powerful, but coordinating several of them manually is
awkward:

- Long-running sessions are spread across terminals.
- Splitting work across agents — implementation/review/testing,
  research/drafting/fact-checking, or any other division of labor — needs a
  routing layer you don't have.
- Worker progress disappears into scrollback.
- Restart recovery depends on each CLI's native session behavior.

Hive adds the coordination layer without replacing the CLIs. The Orchestrator
is a real `agy` / `claude` / `codex` / `opencode` / `gemini` / `hermes` /
`qwen` process, not a scripted PM. Workers are real CLI agents too. Hive
injects a small `team` command into their shells, so they can dispatch,
report, and keep a shared markdown task graph at `<workspace>/.hive/tasks.md`.

## Use It For

**Ship a PR with a reviewer in the loop**

Ask the Orchestrator to implement a change, spawn a reviewer, and keep the
review feedback visible before you merge. The coder edits; the reviewer checks
the diff; the Orchestrator decides what still needs work.

```text
Ship the settings search bugfix. Use one worker to implement it and another to
review edge cases before the final report.
```

**Run a parallel bug hunt**

Give several workers separate slices of a flaky behavior: one reads the server
path, one checks the UI path, one looks for regressions in recent commits. You
watch the reports converge instead of juggling terminals.

```text
Find why mobile reconnect sometimes stalls. Split server transport, browser UI,
and recent commit history across separate workers.
```

**Research, draft, and fact-check without losing the thread**

Let one worker gather sources, another draft, and a reviewer check claims. The
task graph and reports stay in one workspace, so the handoff is inspectable
instead of trapped in chat scrollback.

```text
Write a technical note on our release flow. Have one worker collect evidence,
one draft, and one verify every command and file reference.
```

## Try the demo first

Don't have an agent CLI installed yet? Run `hive`, open the printed URL, and
click **Try Demo** in the first-run wizard. You get a fully client-side
preview — fake orchestrator + two workers, prerecorded scrollback, a
prefilled task list — without touching the server or any real CLI agent.
Useful for deciding whether to install a real CLI.

## Quick Start

Prerequisites:

- Node.js 22.18 or newer within 22.x, or Node.js 24.x.
- To run real tasks, at least one supported agent CLI installed, authenticated,
  and available on `PATH`. Basic workspaces can be created before installing a CLI.

Clone, install, and start this fork:

```bash
git clone https://github.com/zhouyuanxinand/hiveteam.git
cd hiveteam
npm install
npm start
```

`npm start` launches both the local HiveTeam runtime and the Vite web app, then
opens an authenticated browser window, normally on `http://127.0.0.1:5180/`. The existing
`pnpm dev` command remains available for pnpm-based development.

The platform launcher recovers unexpectedly stopped services. **Resources → Platform recovery** also offers current-user sign-in startup on Windows and macOS, off by default. Changes apply at the next sign-in; a normal exit does not restart the platform immediately. See [Platform recovery and sign-in startup](./docs/platform-recovery.md) for recovery limits and CLI path setup.

SQLite uses Node's built-in `node:sqlite`. PTYs use the pinned
`@lydell/node-pty` package with precompiled platform binaries. The built runtime
does not need install scripts or a local C/C++ toolchain. Keep optional dependencies
enabled so the package manager can select the binary for your OS and architecture.

A source checkout still uses `esbuild` to build the frontend; it is the only
approved dependency install script. The optional Electron desktop shell has its
own installation and acceptance steps.

For a packaged installation, `hive` starts the production UI and opens an
authenticated browser window. Use `hive --port 4010` for a specific local port.
The launcher delivers a one-time sign-in link that expires after 60 seconds;
the UI removes it from the address bar when signing in. The printed localhost
URL alone does not issue a management session. After restarting Hive or opening
a different browser profile, enter `o` in the launcher's terminal or reopen from
the desktop tray. Existing windows can refresh while their runtime is running.

To update the source-controlled build:

```bash
git pull origin main
pnpm install --frozen-lockfile
pnpm build
```

Restart the running Hive process after rebuilding. The compatibility command
`hive update` is intentionally local-only and never installs from npm.

Install Hive as an app (optional):

Open `http://127.0.0.1:3000/` in Chrome, Edge, or Brave and click the install
icon at the right edge of the browser's omnibox. The PWA launches in its own
dock-anchored window without browser chrome and shows **Add Workspace** /
**Try Demo** shortcuts from the dock right-click menu. Firefox and Safari
currently don't implement the install-prompt protocol, so the omnibox icon
only appears in Chromium-based browsers.

The Hive daemon must still be running for the PWA to do anything; if the
runtime isn't reachable when you launch the app, you'll see a "Hive runtime
is not running" page that auto-reloads once `hive` is back on `127.0.0.1`.
The PWA install scope is keyed by origin, so `hive --port 4011` installs as
a separate app from `hive --port 3000`. To uninstall, visit `chrome://apps`,
right-click the Hive tile, and choose **Remove from Chrome…**.

Hive asks the browser to confirm before closing the tab or PWA window so an
accidental close shortcut (Cmd-W on macOS, Ctrl-W on Windows/Linux) doesn't
drop your session. Modern browsers gate that prompt on prior page interaction
— if you open the PWA and immediately press the close shortcut without
clicking or typing anywhere first, it still closes cleanly. That's a browser
policy, not a Hive bug.

First-run flow:

1. Create a workspace from a project folder.
2. Keep the default installation of `matt` and `code-janitor`, or explicitly choose Basic mode to skip default packs and create offline.
3. Hive creates `<workspace>/.hive/tasks.md`. Choose and check an Orchestrator preset,
   then start it explicitly (or select the creation dialog's start option). Its session receives the internal `team` command.
4. Add workers from the Team Members panel.
5. Ask the Orchestrator to delegate work. It sends tasks with
   `team send <worker-name> "<task>"`; workers report back with `team report`.

Manage members and their CLI launch settings from the Team Members panel.
The Orchestrator uses `team list` to inspect the team and `team send` to
dispatch to an existing member. Use `team guide dispatch` for the current
dispatch protocol; `team spawn` and `team dismiss` are not CLI commands.

For multi-step work, save a JSON definition under `.hive/workflows`, then open
**Workflows** in the topbar to run it and inspect step results. Each step names
an existing worker and can declare dependencies on other steps. The panel
provides stop and step rerun controls. Only JSON definitions are executable;
TypeScript and other catalogued files are metadata-only. Scheduled workflows
and workflow-created agents are not available.

After a restart, workflows reconcile stored reports for the current step attempt
and resume dependencies without creating another dispatch for that attempt.
Success and human acceptance keep their existing rules; quality conditions must
still be satisfied. Stopping saves the stop request before cancelling unfinished
steps. If cancellation fails, the request remains stored and is retried during
recovery, before affected agents start and replay queued work.

When receipt or cancellation is uncertain, the run is **Interrupted**: new steps
pause while existing tasks can still report. Open **Review delivery** to inspect
the original receipt and use the existing local recovery controls. Receipt
rechecking never resends; resending requires an explicit acknowledgement.
Marking a delivery handled preserves its dispatch and attempt and does not
complete the task or satisfy quality conditions. A cancellation-message receipt
does not prove that execution stopped; reruns still wait for that confirmation.
Safe pending deliveries retain their existing retry path. Backup restore freezes
interrupted runs alongside running ones.

## Share Skills with Skill Packs

Both workspace creation dialogs default to **Install matt + code-janitor**, binding
`tt-a1i/matt-skills-with-to-goal` as `matt` and `zhouyuanxinand/code-janitor` as
`code-janitor` before any requested Orchestrator start. Choose **Basic workspace**
explicitly to create offline without installing default packs; existing skills and files
are preserved in either mode. Default installation includes role profiles, immutable locks, and native `to-goal`, `to-spec`, `to-tickets`,
and `code-janitor` entry points. Janitor is available to the Orchestrator, Coder,
Reviewer, and Tester on demand; binding it does not run a cleanup. The first download
requires Git and access to GitHub. Later creations in Skill Packs mode reuse
and verify the local cache; existing workspace versions are never automatically
updated. Explicitly resolving a newer release makes that cached version
available to new workspaces in that mode.
Existing bindings retain their aliases, versions, and selections; only missing
defaults are added on creation. Existing workspaces are not migrated. Pack-name or native
directory conflicts fail visibly without overwriting user files or starting an
agent. If a later default Pack fails, earlier bindings from this creation are undone;
an unsafe rollback retains the workspace and receipts for recovery. Other CLIs use
Hive's role catalogs and `team skill` on demand; binding a
Pack does not execute its scripts.

Open **Skills** in the active Workspace topbar to bind one locked Skill source
for the whole team:

1. In **Packs**, choose GitHub and enter
   `tt-a1i/matt-skills-with-to-goal` with ref `main`.
2. Click **Resolve release**. Hive fetches without Git submodules or hooks,
   inventories scripts without running them, and previews the exact commit and
   full-tree digest.
3. Assign only the relevant Skills to each role profile. Native exposure is an
   optional, workspace-wide Codex convenience and is limited to 12 Skills.
4. Review the exact filesystem Change Plan, then click **Apply**. Nothing is
   bound or updated before this explicit step.
5. Use **Members** to distinguish universal prompt delivery from native
   discovery, and **Changes** to inspect Receipts or Undo an owned change.

After binding these Packs, use them inside the Orchestrator terminal:

```bash
team skill list
team skill load matt/to-goal
team skill load code-janitor/code-janitor
team send "Alice" "Implement the approved change test-first" --skill matt/tdd
```

The dispatch pins and delivers exactly one immutable Skill snapshot. A Worker
can reload that dispatch's Skill with `team skill load --dispatch <id>` and
read an authorized text reference with
`team skill read --dispatch <id> <relative-path>`.

For Codex, a natively exposed Skill can also be invoked as `$to-goal` after
restarting the affected member. Other CLIs and custom commands remain fully
functional through Hive prompt delivery even when their native Skill directory
is unknown. Matt Skills that assume Codex forks or built-in subagents
(`spec-executor`, `roundtable`, and `execute-spec-in-fork`) are marked as
requiring a Hive adapter and are not selected by default.

## How It Works

```text
Browser UI on 127.0.0.1
  tasks, team, terminals, reports
          |
          | HTTP + WebSocket
          v
Hive runtime
  SQLite metadata, PTY lifecycle, task dispatch
          |
          +-- Orchestrator PTY
          |     can call: team send, team list, team report
          |
          +-- Worker PTY
          |     can call: team report
          |
          +-- Worker PTY
                can call: team report

Workspace task graph:
  <workspace>/.hive/tasks.md
```

Three details matter:

- Agents are real CLI processes, not simulated subagents.
- `team` is injected only inside Hive-managed agent sessions by prepending the
  package's internal bin directory to `PATH`; it is not installed as a global
  command.
- The task graph is a markdown file in the workspace, so you can inspect or
  edit it outside the app.

## Agent Presets

| Preset | Command expected on `PATH` | Session resume |
| --- | --- | --- |
| Antigravity CLI | `agy` | `--conversation <session_id>` |
| Claude Code | `claude` | `--resume <session_id>` |
| Codex | `codex` | `resume <session_id>` |
| OpenCode | `opencode` | `--session <session_id>` |
| Gemini | `gemini` | `--resume <session_id>` |
| Hermes | `hermes` | `--resume <session_id>` |
| Qwen Code | `qwen` | `--resume <session_id>` |
| Cursor CLI | `agent` / `cursor-agent` | Managed identity and recovery adapters; native releases remain unverified |
| Grok Build | `grok` | Managed identity and recovery adapters; native releases remain unverified |
| Custom | Any executable | User configured |

Hive does not install these CLIs for you. Install and authenticate them in the
same shell environment you use to start Hive.

Presets do not add bypass flags. Agents default to a restricted execution policy;
the **Permissions** control shows whether that CLI/platform combination can enforce
it. Unsupported combinations require a local user's explicit unsafe exception for
that agent. Restricted Codex uses a separate CLI home, so authentication must be
configured for that home. See [SECURITY.md](SECURITY.md) for the verified boundary.

## What Hive Provides

- Workspace sidebar for switching between local projects.
- Orchestrator and worker terminals backed by real PTYs.
- Add Worker flow with role presets for coder, reviewer, tester, and fully
  custom prompts and commands — wire any CLI agent into the role you need.
- Workflows: run JSON definitions with up to 20 steps across existing team
  members. Steps support dependencies and quality conditions for reports,
  reviews, and verification; the Workflows panel shows results and provides
  stop and rerun controls. Scheduled workflows are not available.
- Team memory: keep workspace constraints, long-running context, and team
  decisions in Hive so later dispatches can carry the right background.
  [Dream](./docs/memory-dream.md) prepares explicit memory changes or extracts
  candidates from new protocol messages through the workspace Orchestrator.
  Inspect the sources and apply manually; changes have receipts and conflict-aware rollback.
- Dispatch change review: in Git workspaces Hive records the HEAD commit when
  a dispatch is created, so the Activity center can show the working-tree diff
  produced while that dispatch was being worked on, including new untracked
  files. Reviewing changes no longer means trusting a worker's report at face
  value — and you can send review feedback straight back into the worker's
  terminal, which reopens the dispatch for another report round.
- `.hive/tasks.md` editor with external-file conflict handling.
- Background PTY preservation and best-effort native session resume.
- A What's New dialog after upgrades with curated release highlights.
- Local SQLite metadata under `%USERPROFILE%\.config\hive` on Windows and `~/.config/hive`
  on macOS / Linux by default, or `$HIVE_DATA_DIR` when set.

Hive relies on verified CLI sandbox capabilities for restricted execution; it does
not implement its own OS sandbox, multi-user auth, or any bundled agent model.
It coordinates the CLIs you already run locally.

## Remote Access (optional, off by default)

If you want to reach your running Hive from your phone while you're away,
enable optional **Remote access**. After the phone signs in and pairs with the
desktop, it reaches the Hive Web UI through an end-to-end encrypted tunnel.
The desktop selects each device's visible workspaces. Remote access starts
read-only; write actions require a local approval lasting at most ten minutes.

Important boundaries:

- **Off by default.** If you never enable Remote access, Hive remains
  local-first.
- **A gateway is required.** Hive relays the phone-to-daemon connection through
  a gateway; your machine connects outbound and does not require opening a
  public port.
- **Data and execution stay local.** The gateway routes authenticated
  connections; it does not run your agents or store workspace contents.
- **The desktop is the trust root.** New device pairing must be confirmed at
  the computer. A paired phone cannot approve another device by itself, and
  devices can be revoked at any time.

## Platform Support

| Platform | Status | Notes |
| --- | --- | --- |
| macOS | Tier 1 | Main development and release verification target. |
| Linux | Tier 1 | CI configured; see the release workflow results for verification. Native folder picking expects `zenity`; manual path entry works without it. |
| Windows | Tier 2 | CI runs the full test suite through the shared runner and a packaged-install smoke. Folder picking uses the in-browser server filesystem browser and the package includes `team.cmd`. Treat as best-effort — real CLI and desktop acceptance before each release is manual. |

All platforms require Node.js 22.18+ within 22.x, or Node.js 24.x. SQLite is
provided by Node. `@lydell/node-pty@1.2.0-beta.15` supplies precompiled native
binaries for macOS, Linux and Windows on x64 and arm64. This is not a pure
JavaScript PTY implementation. Other OS/architecture combinations do not fall
back to compiling from source.

Windows uses the bundled ConPTY DLL in both production and tests. That upstream
option is experimental, so the PTY version is pinned and upgrades must pass real
terminal and lifecycle acceptance. CI coverage is listed below; availability of
a platform binary alone does not mean that every agent CLI has been certified.
Headless Windows startup can spend about three seconds negotiating terminal
capabilities. Autostart uses a four-second observation window and returns early
on exit, so a CLI that fails during that startup is not reported as successful.

## Safety Model

Hive is a local development tool, not a hosted service.

- When Remote access is off, the runtime binds to `127.0.0.1`. Do not expose
  the Hive port through a public tunnel, reverse proxy, or shared network
  interface.
- Remote devices have explicit workspace scopes and temporary action grants;
  they cannot approve their own permissions or change execution security policy.
- Restricted workers start only when the required CLI sandbox capabilities are
  verified. Unsafe exceptions run with the authority of the account running Hive.
- Open only trusted workspaces. Worktrees alone are not filesystem sandboxes.
- Agent tokens are session scoped, generated by the local runtime, injected into
  agent process environments, and not intended as internet-facing credentials.
- Hive authenticates local users, agents, and remote devices separately. It does
  not provide an OS boundary against unrestricted processes under the same user.
- The browser UI token is a local session guard, not protection against other
  processes already running as your OS user.

Read [SECURITY.md](SECURITY.md) before using Hive with sensitive repositories.

The local **Resources** panel controls execution limits: eight globally, four per
workspace, twelve worker members per workspace, and one verification per workspace
by default. Orchestrators, workers, workspace shells, and verifications share the
execution budget. Idle processes count until they exit; stopped workers remain
members until deleted. Queued work resumes when capacity becomes available.
These are execution-count limits, not CPU or memory limits. Each data directory
allows one active runtime.

## Data Locations

| Data | Location |
| --- | --- |
| Runtime metadata | Windows: `%USERPROFILE%\.config\hive`; macOS / Linux: `~/.config/hive`; or `$HIVE_DATA_DIR` |
| Workspace tasks | `<workspace>/.hive/tasks.md` |
| Internal `team` command | Packaged under `dist/bin/`, injected into PTYs |
| Web UI assets | Served by the runtime from the packaged `web/dist` build |

The CLI, `npm start` / `pnpm dev`, and both desktop launch modes use the same
default: `<OS home>/.config/hive`. Startup logs show the selected absolute
`Data directory`. `HIVE_DATA_DIR` selects a custom directory; a relative value
is resolved against the launcher's invocation working directory before it starts
child services. npm / pnpm may set that working directory to the package directory.
Use an absolute path to select the same data from different launch locations:

```powershell
$env:HIVE_DATA_DIR = 'D:\HiveData'
npm start
```

```bash
HIVE_DATA_DIR=/absolute/path/to/hive-data npm start
```

Windows and WSL have separate home directories and environment settings, so each
has its own default. Hive does not translate paths between them or automatically
find, copy, or merge databases from other directories. An explicit override is
honored even when another directory already contains saved data.

See [Workspace and native session recovery](docs/session-recovery.md) for restart
behavior, per-member conversation bindings, and recovery failure handling.

Use `team send --messages` to opt a new dispatch into persistent questions,
answers and progress messages. See [Dispatch conversations](docs/dispatch-messages.md)
for history, explicit read sequences and rework behavior.

Dynamic staffing is disabled by default. Authorize presets and a temporary-member limit in the member panel, then use `team staffing`, `team spawn` and `team dismiss`. See [Dynamic staffing and retirement](docs/dynamic-staffing.md).

`team review --dispatch <id> [--cli <preset>] "<focus>" requests a temporary reviewer pinned to the reported commit. Findings and retained worktrees remain available after retirement. See [One-shot reviewer tasks](docs/one-shot-reviews.md).

Open **Activity center → Needs attention** to find unanswered questions, pending report delivery, stopped members with queued work, reports awaiting acceptance and remote connection issues. Each item opens its existing controls. See [Needs attention](docs/activity-attention.md).

[Collaboration statistics](docs/collaboration-statistics.md) shows root-task counts, duration coverage, and measured prompt bytes.

Local backup, inspection, restore-to-new-directory and reversible dispatch
archiving are available in the knowledge drawer and through `hive data --help`.
Backups exclude credentials and do not include workspace source files. See
[Local backup and recovery](docs/local-data-recovery.md) before migrating data.

## Troubleshooting

**Agent CLI not found**

Check that the selected command is installed, authenticated, executable from the
same shell, and available on `PATH`.

**Port already in use**

Start Hive with another local port:

```bash
hive --port 4020
```

**Source changes do not appear after pulling**

Stop the running Hive process, pull the selected branch, rebuild, and start the
local runtime again:

```bash
git pull origin main
pnpm install --frozen-lockfile
pnpm build
node dist/src/cli/hive.js --port 4010
```

If the command still points at a global install, check `which hive` / `where
hive` and use the built `node dist/src/cli/hive.js` entry point explicitly.

**PTY platform package is missing**

Check `node --version`, `node -p "process.platform + '/' + process.arch"`, and
that optional dependencies were installed. Remove `--omit=optional` or equivalent
package-manager settings and reinstall for the machine running Hive. Do not copy
`node_modules` between operating systems or architectures.

The built package supports `npm install --ignore-scripts <archive.tgz>` and
requires no native rebuild. Source builds still need frontend build tooling;
if its installation is blocked, review and approve `esbuild` in the source
checkout. Electron is installed separately with `pnpm desktop:install`.
Run `pnpm release:compat` from the checkout to inspect runtime modules and CLI
availability.

**Folder picker does not open on Linux**

Install `zenity`, or paste the workspace path manually.

**Folder picker on Windows**

Windows uses Hive's in-browser server filesystem browser when adding a
workspace. It starts from "This PC" and lets you enter drives such as `C:\` or
`D:\`. If the target folder is not listed, expand the advanced path entry and
paste the absolute path.

**A global Hive command is still starting the old build on Windows**

Use the source build directly while developing this fork:

```powershell
pnpm build
node dist/src/cli/hive.js --port 4010
```

Use `where hive` to find older global shims that may still be ahead of this
repository in `PATH`.

**Codex reports missing model metadata**

Codex 0.155.1 can fall back to missing metadata for `gpt-6-sol` on a cold start.
Update the CLI Hive actually launches and restart the member after its task finishes.
See [model metadata troubleshooting](docs/codex-model-metadata.md) for version checks
and execution-permission implications.

**Codex terminal cannot scroll on Windows**

Use the current HiveTeam source build and restart it. Codex is a full-screen
TUI, so it usually will not show a browser-native scrollbar; HiveTeam translates
wheel, PageUp, and PageDown input into terminal input Codex understands. The
current source build includes the Windows launch-command fix for saved commands
that still point at `node.exe ...\@openai\codex\bin\codex.js`.

**Tasks file conflict banner appears**

Hive detected a newer `.hive/tasks.md` on disk. Use `Reload` to accept the file
from disk, or `Keep Local` to keep the editor contents and save again.

**Worker appears stuck in `working`**

Hive does not guess task completion from process activity. Workers move back to
`idle` when they call `team report`. If a worker is blocked, stop or restart it
from the UI.

## Development

```bash
pnpm install
pnpm dev
```

Development mode runs the runtime on `127.0.0.1:4010`; Vite runs on
`127.0.0.1:5180` and proxies API and WebSocket traffic to the runtime.

### Optional desktop shell

The browser cannot reveal an arbitrary dropped folder's absolute OS path. For
native folder drag and drop, install and start the isolated Electron shell:

```bash
pnpm desktop:install
pnpm desktop:dev
```

The launcher asks whether to use the Electron client or the default Web
browser, and opens only that interface. Web mode remains manageable from the
system tray; Desktop mode adds native close confirmation and folder handling.

Drop one folder anywhere on the HiveTeam window. The normal Workspace
confirmation dialog opens with its exact path, including non-ASCII characters
and spaces. Browser-only startup remains unchanged.

To run the real desktop drag acceptance against a known folder:

```bash
pnpm desktop:acceptance -- "/absolute/path/with spaces"
```

Run these checks before submitting a non-trivial change:

```bash
pnpm check
pnpm typecheck
pnpm build
pnpm test
```

`pnpm check` runs Biome. `pnpm typecheck` checks the runtime, web UI, tests,
and gateway without emitting build output. `pnpm build` verifies the production
build. `pnpm test` runs the full suite through the shared runner with an isolated
temporary Hive data directory, as CI does on macOS, Linux, and Windows.
`pnpm test:windows` is an alias for the same full suite.

To run one test file with the same isolation:

```bash
pnpm test tests/unit/task-markdown.test.ts
```

### Release artifact verification

To build one package and verify that exact archive locally:

```bash
pnpm build
node scripts/create-release-artifact.mjs --output ../hiveteam-release
node scripts/pack-smoke.mjs --artifact ../hiveteam-release/release-manifest.json --report ../hiveteam-release/smoke-report.json
```

The manifest records the source commit, dirty-tree state, lockfile hash, packaging
environment, and archive SHA-256. The smoke command checks the archive before
installing it in a temporary directory, then exercises the installed runtime's
HTTP, WebSocket, native PTY, team delivery, stop, and restart paths. Its JSON report
records the actual environment and results; browser checks are reported as not
run unless a Playwright module is supplied through `HIVE_PLAYWRIGHT_MODULE`.

Artifact creation packages the existing build without rebuilding it. Install
lifecycle scripts remain enabled during acceptance.

Without `--artifact` or `HIVE_RELEASE_MANIFEST`, `pnpm pack:smoke` still packages the current build.
Set `HIVE_RELEASE_MANIFEST` to an absolute manifest path to reuse an existing
archive, including from package integration tests. The explicit `--artifact`
option takes precedence. Use `--expected-platform`, `--expected-arch`, and
`--expected-node` to require a specific environment.

The release workflow is configured to build once on Ubuntu 24.04 / Node 24.14.0
and share that archive across these twelve installed-package checks (each row runs both default installation
and installation with lifecycle scripts disabled):

| Runner | Platform / architecture | Exact Node versions |
| --- | --- | --- |
| `ubuntu-24.04` | `linux` / `x64` | `22.18.0`, `24.14.0` |
| `windows-2022` | `win32` / `x64` | `22.18.0`, `24.14.0` |
| `macos-15` | `darwin` / `arm64` | `22.18.0`, `24.14.0` |

Both install modes run the same HTTP, SQLite restart, `team`, Unicode terminal,
resize and process cleanup checks. To exercise the second mode locally, add
`--ignore-scripts` to `pnpm pack:smoke`.

Source checks run on the same three runners with Node 24.14.0. They restore
`dist/` and `web/dist/` from the verified archive for integration tests. Each
installed-package job uploads its report even when acceptance fails. This table
describes the configured coverage; the workflow run and its reports provide the
pass/fail evidence. The workflow does not publish a package.

Production-style local run:

```bash
pnpm build
node dist/src/cli/hive.js --port 4010
```

The production server serves the built web UI directly. No Vite server is
needed after `pnpm build`.

## Source-controlled build

This fork is intentionally maintained from Git. There is no official npm
update channel in the application; pull the repository and rebuild when you
choose to move to a newer commit.

## Status

Hive is in alpha. This repository includes multi-CLI agent presets, member
management, JSON Workflows, team memory, PWA installation, and optional Remote
access. The checked-out commit is the source of truth for the running build.

## A different form factor: squad

If you'd rather have **pure CLI, zero background process, and the ability to
run on a remote SSH box**, [squad](https://github.com/mco-org/squad) takes the
same idea down a different path — SQLite as the protocol layer, one terminal
per agent. The two projects don't replace each other; pick by workflow:

- **Hive** — visual workbench, one-click restart, workspace sidebar, easier to demo to a team
- **squad** — lives in tmux, SSH remote dev, no extra background process, Windows servers

## Acknowledgements

The built-in template marketplace ships snapshots of two community-maintained prompt libraries, both distributed under their upstream MIT licenses:

- English (used when the UI is set to EN): [`msitarzewski/agency-agents`](https://github.com/msitarzewski/agency-agents)
- Chinese (used when the UI is set to 中文): [`jnMetaCode/agency-agents-zh`](https://github.com/jnMetaCode/agency-agents-zh)

Upstream content is mirrored verbatim, license files are kept under `vendor/marketplace/<lang>/LICENSE`, and snapshots are refreshed by `pnpm sync:marketplace` before each Hive release.

## License

Hive is open source under the Business Source License 1.1. Personal use, internal deployment, embedding, and forks are permitted — see [LICENSE.BSL](LICENSE.BSL) for the exact boundary. Use of the Hive name, logo, and visual identity is covered by [TRADEMARK.md](TRADEMARK.md).
