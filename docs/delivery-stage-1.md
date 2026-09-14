# Delivery workbench: stage 1 acceptance

Branch: `codex/delivery-workbench`, based on local `main` at `2cbd02f`.
Changes remain on this branch until user acceptance and an explicit merge.

## Implemented behavior

- `team report` accepts `--outcome success|failed|blocked|partial`. The HTTP
  report endpoint accepts the optional `outcome` field. Existing reports without
  it remain valid and retain an unknown outcome. Legacy `--success` / `--failed`
  flags retain their existing no-op behavior; use `--outcome` to declare a result.
- Transport status and Agent `idle/working/stopped` states keep their existing
  meanings. Finishing a report closes that dispatch's pending work, including
  when the declared outcome is blocked or failed.
- Workflow dependencies advance after an explicit successful report. Failure,
  blockage, and partial completion pause the step. A report with no outcome
  waits for human acceptance. Execution completion is separate from acceptance.
- The workspace's Delivery strip summarizes the latest 100 dispatches and
  refreshes while the page is visible. Expand it to read task reports and
  artifacts, inspect existing Git diffs, accept reports, or return feedback.
  The Activity center exposes the same report controls.
- Human acceptance is stored in SQLite against a report revision. A stale
  acceptance request returns 409. Failed/blocked/partial results cannot be
  accepted. Feedback clears the acceptance, reopens the dispatch, and the next
  report receives a new revision. Restart preserves reports and acceptance.
- Feedback on a completed workflow step invalidates that run and cancels its
  pending dependent work. Start a new workflow run after revision. Feedback on
  a blocked or awaiting-review step lets the existing run continue after a
  successful revised report.

## Manual acceptance

Run the built branch from its worktree in a separate PowerShell terminal:

```powershell
$env:HIVE_DATA_DIR = Join-Path $env:TEMP 'hive-delivery-stage-1'
node dist/src/cli/hive.js --port 4018
```

Open `http://127.0.0.1:4018`. This uses separate runtime data from the normal
Hive installation. Add a disposable Git project and configure real CLI workers
for the end-to-end checks below.

The separately running local preview at port 4017 contains explicitly labeled
demonstration reports and echo PTYs. It supports inspecting and trying the
report controls; it does not perform coding or validation.

1. Start this branch with an isolated runtime data directory, add a workspace,
   and start a worker. Dispatch a task from the Orchestrator with `team send`.
2. In the worker, run `team report "Blocked by missing input" --dispatch <id>
   --outcome blocked`. Delivery should show an item needing attention, with no
   acceptance button. The worker's pending count should decrease.
3. Expand the item, enter the missing information, and return it to the worker.
   It should become in progress. Report again using `--outcome success`; it
   should show reported success and remain awaiting human acceptance.
4. Accept the report. It should show report accepted. Restart Hive with the
   same isolated data directory and verify that this state remains.
5. Send feedback again. Acceptance should disappear. An old browser request
   attempting to accept the previous report revision must be rejected.
6. Repeat with a JSON workflow containing `implement` and dependent `review`
   steps. Failed/blocked/partial implementation reports must not dispatch
   review. A legacy report waits for confirmation; explicit success releases
   the dependent step. Check both Chinese and English UI text.

## Verification

Completed on Windows for this stage:

- `pnpm check`: passed (619 files).
- `pnpm build`: passed (production TypeScript and frontend assets).
- `pnpm test`: passed (208 test files, 1,067 tests; 2 files / 5 tests skipped
  by the suite's existing configuration).

Runtime coverage crosses the HTTP, SQLite, and PTY boundaries. It checks outcome
handling, pending counts, dependency gating, authenticated acceptance, stale
revisions, feedback, restart persistence, and the additive schema migration.
Browser component tests check rendered acceptance, feedback, and error states.
Desktop (1440px) and narrow (390px) layouts were inspected in Chrome.

The additional whole-repository `pnpm exec tsc --noEmit` check still reports
seven existing test typing errors, also reproduced on the base `main`:
nullable terminal viewers, missing declarations for two desktop modules, and
the Skill pack drawer test's fetch mock types. These are outside this stage.
The production TypeScript build passes.

## Boundaries and subsequent stages

This stage confirms task reports. It does not claim that code is independently
verified or eligible to merge. Existing dispatch diffs still compare the shared
workspace against the dispatch baseline; they are not immutable per-task output.

Next stages, separately reviewable on this branch:

1. Bind validation evidence and review decisions to immutable code versions.
2. Isolate independent coding tasks with worktrees and integrate their output.
3. Connect accepted output to PR, CI, and merge status.

The latest-100 view is intentionally a recent-activity view. A complete,
cross-workspace pending-action queue belongs to the subsequent delivery view.
