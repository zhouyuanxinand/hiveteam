# Delivery workbench: stage 2 acceptance

This stage builds on `43be040` on `codex/delivery-workbench`. The branch remains
separate from local `main` pending user acceptance.

## Behavior

Each reported task now offers **Verify code version**. Enter a foreground check
command, review its output, and accept the verified version after it passes.

- Hive creates a detached temporary checkout of the requested commit and runs
  the command there, at the same repository-relative workspace path. The source
  branch and index are not changed. Dependencies and ignored local files are
  not copied; include installation in the command when needed.
- Evidence records the command, complete commit SHA, report revision, exit code,
  timestamps, and the first 64K characters of combined stdout/stderr in SQLite.
  Each workspace runs one verification at a time, with a 15 minute limit.
- A nonzero exit, launch/cleanup error, or a command that changes checkout files
  or HEAD cannot produce a passing result. Cancellation terminates the command
  process tree and removes the owned temporary checkout.
- Version acceptance is available only for the latest passing run, the same
  report revision, and the same clean current commit. A later failed run, changed
  report, changed commit, or uncommitted code makes earlier acceptance inapplicable.
  Historical evidence remains available; the dialog shows the latest 10 runs.
- Accepting a verified version also confirms its task report. The first-stage
  report-only confirmation remains available and retains its distinct meaning.
  Neither operation merges code or proves checks beyond the chosen command.
- The two untracked files Hive itself creates, `.hive/tasks.md` and
  `.hive/PROTOCOL.md`, are coordination metadata and do not make the source dirty.
  Tracked modifications to those files still invalidate the clean version check.

## Local acceptance

The preview at `http://127.0.0.1:4017` uses an isolated demonstration Git project.
Its workers are echo processes with labeled example reports. The verification
button runs real checks against the example project.

1. Expand **Delivery**, then the example search task, and open **Verify code
   version**. Run `node verify.cjs`.
2. Verify that the commit, command, exit code `0`, and two sample checks appear.
   Accept the version and confirm the accepted state appears.
3. Run `node -e "process.exit(3)"`. The new failure must supersede the previous
   pass and offer no acceptance action.
4. Run the passing command again. Change a source file without committing it;
   refresh the dialog and verify that earlier acceptance cannot apply. Commit
   the change and verify again to obtain evidence for the new commit.
5. Return the task to the worker from its report controls. After a new report,
   the previous verification must be shown as belonging to an older report.
6. Run `node -e "setInterval(() => {}, 1000)"`, then cancel. Check the cancelled
   state and that `git worktree list` has no remaining checkout for that run.

For real CLI acceptance, start the built branch from its worktree in a separate
PowerShell terminal, then add a disposable Git project and configure its agents:

```powershell
$env:HIVE_DATA_DIR = Join-Path $env:TEMP 'hive-delivery-stage-2'
node dist/src/cli/hive.js --port 4018
```

For example, a pnpm project could verify with
`pnpm install --frozen-lockfile && pnpm check && pnpm build && pnpm test` when
those scripts are defined by that project.

## Scope and lifecycle

The temporary checkout isolates source files; verification commands run as the
local user. This stage does not introduce a sandbox, per-coding-task worktrees,
or PR/CI/merge orchestration. The command's checks determine the scope of its
evidence. Ignored local configuration and external services are not versioned
by this record.

Normal shutdown waits for cancellation and cleanup. After a hard runtime crash,
unfinished persisted records become interrupted and cannot be accepted. A hard
crash may leave a process or temporary worktree requiring inspection and cleanup;
restarting Hive does not treat those records as completed or resume the command.

The next stage will isolate concurrent coding tasks and integrate their output.

## Verification

Completed on Windows:

- `pnpm check`: passed (630 files).
- `pnpm build`: passed.
- `pnpm test`: passed (210 test files, 1,076 tests; 2 files / 5 tests skipped
  by the existing suite configuration).

Real HTTP/SQLite/Git/process integration coverage includes successful execution,
failure precedence, source isolation, stale versions and reports, authenticated
acceptance, restart persistence, unfinished records, cancellation, and bounded
logs. UI tests cover acceptance after the server response, run/cancel controls,
and stale evidence. The real Chrome preview was exercised through run and
accept, with desktop (1440px) and narrow (390px) screenshots inspected.

The additional whole-repository type check still reports the same seven
pre-existing test typing errors documented in stage 1; no new errors were added.
