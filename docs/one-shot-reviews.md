# One-shot reviewer tasks

The Orchestrator can request a temporary reviewer for a reported dispatch:

```sh
team review --dispatch <source-dispatch-id> --cli <allowed-preset> "Inspect API compatibility and error handling"
```

Enable dynamic staffing in the member panel first and authorize the CLI presets and temporary-member limit. The default limit is two; existing resource budgets still govern starts. See [Dynamic staffing](dynamic-staffing.md). Only the Orchestrator can request reviewers. A request creates an independent checkout and a child dispatch in the existing task ledger.

The source must have a report and a clean, committed version available to the existing code-review service. The request records the source dispatch, report revision, full source and comparison SHAs, repository identity, and focus. The reviewer starts at that recorded commit even if the source advances while it waits for capacity. Its checkout is checked again before launch. Changes to that checkout block another start and remain available for inspection.

`--cli` is optional. Without it, HiveTeam prefers an authorized preset different from the source worker's preset, then the first available authorized preset. A different preset does not guarantee a different model. A new reviewer uses the usual role, launch, Skill-readiness and execution-policy paths; it does not inherit the Orchestrator's execution grants.

## Retries and failures

Use a stable UUID v4 with `--request-id <uuid>` when retrying a request whose response may have been lost. An identical request returns the same reviewer and child dispatch. Reusing the ID with a different source, focus, explicit preset or actor is rejected. Omitting the flag generates a fresh ID, so a second invocation creates a new review.

The request response is JSON containing `id`, `reviewer_id`, `review_dispatch_id`, `state`, and `last_error`. HTTP 201 acknowledges durable admission, not completion: inspect these fields. A start failure leaves a failed child dispatch and its diagnostic; queued requests wait for capacity. Repair the launch configuration and retry delivery through the existing controls, or cancel the child task. Git preparation failures may have no child dispatch: inspect the retained directory, dismiss the temporary member, and issue a new request. Reusing the old request ID never silently creates another member.

A runtime restart marks an admission interrupted before child-task creation as failed, keeps its directory, and blocks automatic launch. Reviewer failure or cancellation does not cancel the source task.

## Findings and retirement

Inside the reviewer:

- `team review context --dispatch <source-dispatch-id>` and `team review file ...` read the originally assigned snapshot. A temporary reviewer cannot retarget these commands to another source dispatch.
- Finish with `team report --dispatch <review-dispatch-id> --outcome success|failed|blocked|partial "<findings>"`. Use the child review dispatch ID. The usual task-message acknowledgement rules apply if messages arrive during review.
- Optionally submit structured evidence with the existing `team review submit` command and the original version. This still requires an enforced read-only reviewer run and a current, clean source version. A plain task report does not create an approval.

Findings never accept the source report, pass verification, or integrate code. The existing verification and explicit acceptance/integration gates remain in force. If the source report revision, commit, comparison baseline, repository or cleanliness changes, the history marks earlier findings as stale while preserving their text.

After the review is reported or cancelled and the reviewer has no other open dispatches, HiveTeam retires it and stops its PTY. Retirement preserves the child report, pending report delivery, identity, configuration and worktree. A pending report can still be delivered after restart. Cleanup remains explicit, including when the reviewer left modified or untracked files.

Expand **Temporary reviewer tasks** in the source report's code-review panel to see the latest 50 requests, their fixed versions, findings, retirement, and retained-directory details. Desktop users can open the existing worktree resources panel from there. Older requests remain available by ID through the authenticated UI endpoint:

```text
GET /api/ui/workspaces/:workspaceId/review-requests/:requestId
```
