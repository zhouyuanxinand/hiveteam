# Delivery workbench — stage 3

This stage adds persistent working directories for isolated workers and an
explicit integration action for accepted code. It extends stages 1 and 2 on
`codex/delivery-workbench`; the development branch remains separate from main.

## Working directories

Select **Use an isolated working directory** when adding a worker. Hive requires
a clean, committed Git branch and a persistent data directory outside the project
repository. It creates a `hive/worker-<uuid>` branch at the current commit and a
Git worktree under `<HIVE_DATA_DIR>/worker-worktrees/`. A workspace opened at a
repository subdirectory keeps the same relative directory in the checkout.

The worker's real PTY starts there, including starts triggered by dispatch and
starts after a runtime restart. SQLite preserves the binding. A missing checkout,
changed branch, or failed preparation blocks launch. An existing worker keeps
its original shared directory; isolation is selected during creation.

Isolation is per worker. Further tasks assigned to that worker reuse its branch,
directory, and native conversation. Use separate workers for independent parallel
coding tasks. This avoids moving an active CLI conversation between directories.
Other workers do not automatically receive this branch. Provide its directory
or commit to reviewers, or integrate it before starting tasks that depend on its code.
The team list exposes `worktree_branch` and `working_directory`; the worker card
marks isolated workers and exposes the directory in its tooltip.

Dispatch baselines, task diffs, and version verification resolve the worker's
directory. Verification still runs in a temporary detached checkout of that
directory's exact commit. Changes in the shared target directory therefore do
not contaminate evidence for isolated code.

## Review and integration

After a success report, open **Verify code version**, run the project's checks,
and accept the verified version. An isolated task also displays **Integrate
accepted code** with the source branch, target branch, commit IDs, working
directory, and the complete repository diff from target to source. Large patches
are capped at 256 KiB and explicitly labeled as truncated.

Clicking **Integrate into <branch>** requests a fast-forward to the accepted
commit. The server checks the preview's full source SHA, target SHA, and latest
verification ID again. Integration requires:

- A current, successful, accepted verification of the report and source commit.
- Clean source and target directories, with the original target branch checked out.
- No unfinished task for this worker, and no live PTY for this worker or agents
  using the shared project directory. Other isolated workers may keep running.
- A target commit that is an ancestor of the source commit.

The operation is serialized with Hive's workspace Git operations and agent
starts. Git uses `merge --ff-only` with hooks disabled, so the result is the
verified commit itself. SQLite records the integrated verification and time;
repeating an already completed integration preserves its receipt.

If the target has diverged, update the isolated branch against the target, resolve
any conflicts there, then report, verify, and accept that new version. The UI
does not auto-resolve conflicts, create an unverified merge commit, or push.
Integration reviews all outstanding changes on the worker branch, including
changes accumulated across its tasks.

## Local acceptance

The local preview at `http://127.0.0.1:4017` uses a disposable sample repository.
Its labeled example task changes case-sensitive search to case-insensitive
search. `node verify.cjs` performs two real assertions in a detached checkout.
The demo's integration action changes only that sample repository.

For a real CLI exercise, use Node 22 or later, start the built branch, and bind a
disposable committed Git project:

```powershell
$env:HIVE_DATA_DIR = Join-Path $env:TEMP 'hive-delivery-stage-3'
node dist/src/cli/hive.js --port 4018
```

1. Create two workers with isolated directories and dispatch independent tasks.
   Confirm their `pwd`/`Get-Location` values and branches differ, and that edits
   leave the original project unchanged.
2. Restart Hive. Start a worker and confirm it returns to its recorded directory.
3. Commit an isolated change, report success, verify, and accept it. Inspect both
   the task diff and integration diff; confirm they contain the isolated change.
4. Stop the source worker and agents using the shared directory. Refresh the
   integration preview and integrate. Confirm target HEAD equals the accepted SHA.
5. On another task, change target HEAD after preview, leave uncommitted target
   changes, or diverge its branch. Integration must be blocked without changing
   the target or leaving a conflicted merge.
6. Delete an isolated worker. Its branch and working directory must remain on
   disk; the deletion dialog states this before removing the worker's records.

## Lifecycle and limits

Worker worktrees are retained across shutdown and worker/workspace deletion.
Deletion removes Hive's records, not the code. Use `git worktree list` to inspect
retained checkouts and standard Git worktree removal after reviewing their output.
Failed or interrupted preparation remains visible and cannot start in a shared
directory as a fallback. A hard crash can leave a checkout requiring inspection.

These are Git working directories, not an OS sandbox. CLI agents and verification
commands run with the local user's permissions. Ignored dependencies and local
configuration are not copied; prepare them through the chosen CLI or verification
command. The workspace task board and Skill configuration remain workspace-wide.
Verification remains one active command per workspace. PR creation, remote CI,
automatic rebasing, and worktree garbage collection are outside this stage.
PR/CI tracking, the global delivery queue, controlled merge updates, and explicit
directory reclamation are added in [stage 4](delivery-stage-4.md).

## Validation

Real HTTP, SQLite, Git, and PTY coverage exercises separate directories, persisted
bindings, concurrent creation, failed and interrupted preparation, subdirectory
workspaces, actual process exit on shutdown, isolated diffs and verification, accepted
fast-forwards, authentication, stale previews, dirty files, divergent targets,
live-worker blocking, invalid worktree branches, and retained output on deletion.
UI coverage checks the displayed commits and diff, waits for the integration
response before showing success, and keeps rejected actions blocked until refresh.

The Chrome acceptance flow covers verification, acceptance, diff review, and
integration in the sample repository. Desktop and 390px mobile screenshots cover
the creation and integration controls.

Validation runs use Node 22.23.2, matching the repository's Node 22 minimum and
the installed native SQLite/PTY modules. The required commands are:

```text
pnpm check
pnpm build
pnpm test --no-file-parallelism --maxWorkers=1 --testTimeout=60000 --hookTimeout=60000
```

Final check and production build both passed. A complete regression run on
2026-09-15, with all final corrections committed, passed 1,086 tests with zero
failures and 5 existing skips. Across 214 test files, 212 passed and 2 were skipped.
The full run completed in 533 seconds.

This includes all eight isolated-worktree tests, all seven worker-flow tests,
the integration panel's two UI tests, and the existing report acceptance,
version verification, native session recovery, and package installation suites.
Preparation failures persist their error immediately, PTYs terminate before
directory cleanup, and the real lazy dialog loads during test setup without
relaxing interaction waits or replacing HTTP/PTY behavior.

The additional whole-repository `pnpm exec tsc --noEmit` check still reports
the same seven existing test typing errors documented in stages 1 and 2. They
are in terminal flow control, desktop module declarations, and Skill pack
drawer fetch mocks; production compilation passes.
