# Dispatch conversations

The workspace Orchestrator and the assigned worker can exchange notes, questions,
answers and progress messages on an existing dispatch. Messages do not create
additional pending work or complete the dispatch.

## Opt in

```sh
team send "Coder" "Implement the API" --messages
team message --dispatch <id> --kind question --stdin
team message --dispatch <id> --kind answer --reply-to <question-id> --stdin
team messages --dispatch <id> --after 0 --limit 50
team report "Implemented and tested" --dispatch <id> --seen-seq <required_seen_seq> --outcome success
```

`--messages` creates message protocol version 1. Existing dispatches and a send
without this flag remain version 0 and use the existing feedback flow. The
protocol version cannot be changed after creation.

Read every page before reporting and address incoming messages. The history
response includes `required_seen_seq`, `latest_seq`, and `next_after`. Follow
`next_after` until it is null. The required sequence describes all current
incoming messages, including messages beyond the current page. A GET does not
write an acknowledgement. Pass the sequence explicitly with the report; the
server does not infer understanding from a read, terminal write or receipt.

When an incoming message commits before a report carrying an older sequence,
the report returns HTTP 409 with `code: "stale_seen_seq"`. The report revision,
acceptance, pending count and report outbox remain unchanged. Read the new
messages, address them and retry. A sequence ahead of the history is rejected.
Without incoming messages, an omitted sequence means zero. Protocol 1 reports
must name their dispatch explicitly.

When the report commits first, subsequent messages return HTTP 409 with
`code: "dispatch_closed"`. Request rework through the existing dispatch feedback
action in the UI. Reopening, invalidating acceptance and saving its new required
message commit together. The next report revision receives a new transport
receipt; previous receipt evidence and uncertain writes remain available.

## HTTP contract

- `POST /api/team/send` accepts optional `message_protocol_version: 0 | 1`.
- `POST /api/team/message` accepts `project_id`, `from_agent_id`, `token`,
  `dispatch_id`, `kind`, `body`, and optional `reply_to`.
- `GET /api/team/messages` accepts `project_id`, `dispatch_id`, optional `after`
  and `limit`, with `x-hive-agent-id` and `x-hive-agent-token` headers.
- `POST /api/team/report` accepts optional integer `seen_seq`.

Kinds are `note`, `question`, `answer`, and `progress`. An answer must reference
an incoming question in the same dispatch. Other replies also reference incoming
messages in that dispatch. Only its owner and workspace Orchestrator can read
or send messages; membership in the same workspace alone is insufficient.
Bodies are limited to 8 KiB in UTF-8; page size is 1–100, default 50. Message IDs
are UUIDs and sequence numbers increase within each dispatch. Message text is
stored verbatim and wrapped as untrusted data when delivered to a terminal.

## Delivery and recovery

Messages use the existing persistent delivery scheduler and recipient ordering.
An offline recipient keeps its queue until explicitly started. Receipt checks,
bounded retries, runtime shutdown and restart follow the existing
[report delivery rules](report-delivery.md). Uncertain input is not pasted again;
use the activity panel to inspect and resolve it. The panel labels these records
as task messages. A transport receipt does not acknowledge understanding.

Closing a dispatch resolves messages that have not started delivery. Messages
and receipt history remain readable. Writes already in progress or uncertain
retain their evidence and continue to fence automatic input as necessary.
Recovery summaries and `team recovery` point protocol 1 dispatches back to
their message history; they do not invent an acknowledged sequence.

Schema 60 preserves existing dispatch protocol defaults, delivery row ordering,
receipt IDs, checkpoints and audit events while extending the delivery kind.
The schema change is transactional. No model account is needed for the SQLite,
HTTP, mailbox and real PTY integration tests.
