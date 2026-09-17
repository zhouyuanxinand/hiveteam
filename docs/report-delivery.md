# Worker report delivery

`team report` stores the worker's result before forwarding it to the
Orchestrator. `reported`, receipt by the Orchestrator, independent verification,
and human acceptance are separate states. An immediate response of
`delivery_state: "delivering"` with `forwarded: false` is asynchronous, not a
claim that the model has received the result.

## Codex acknowledgement

For a Codex Orchestrator, the durable outbox attaches a unique receipt marker.
Hive waits for an empty composer, pastes once, then waits for either the pasted
content indicator or the visible multi-line receipt before pressing Enter.
If Enter is ignored, it can retry submission of that same paste up to three
times. It does not blindly paste the entire report again.

Delivery is recorded only after the bound Codex session journals the receipt
as user input. Assistant output, tool output, task-start events, and terminal
echoes cannot acknowledge a report. The reader checks session identity and
workspace, reads complete JSONL records incrementally, and handles split UTF-8
writes without treating partial records as receipts.

Only one report per recipient occupies the composer at a time. After a
confirmed receipt, the next queued report is attempted even without another
browser poll. A persisted receipt can repair an acknowledgement interrupted
by a runtime restart without re-sending input.

## Pending or uncertain delivery

The worker result and delivery checkpoint remain in SQLite. The activity
center exposes the pending-delivery diagnostic through the existing
`report_delivery.last_error` field. Reports do not expire.

- Missing session binding or a non-empty composer: no report is pasted.
- User input during delivery: automatic Enter stops; Hive will not submit the
  user's draft. Focus notifications and terminal capability replies are not edits.
- No receipt after the bounded wait: the report remains pending, not delivered.
- A different terminal run with uncertain prior acceptance: inspect the prior
  session before manually resending. Hive cannot promise exactly-once model
  execution when the native application cannot prove whether it accepted input.

The schema migration adds receipts and checkpoints without replaying historical
rows already marked delivered. An old report stranded by the previous version
must be checked separately; blindly replaying old completed rows could trigger
duplicate work. Other CLI adapters keep their existing submission behavior.

## Regression coverage

`tests/server/codex-report-delivery.test.ts` crosses real PTYs and SQLite for
slow pastes, ignored Enter, expanded multi-line input, simultaneous reports,
user edits, interrupted acknowledgement, and permanently unconfirmed input.
`tests/server/codex-report-journal.test.ts` covers receipt parsing and migration.
No real model account or network is required by these tests.
