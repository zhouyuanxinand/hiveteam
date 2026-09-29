# Needs attention

Open **Activity center → Needs attention** for the selected workspace. The existing
workspace activity view remains the initial tab. Filter by item type, refresh, or
page through 25 items at a time. The first page refreshes every five seconds;
refreshing from a later page starts a new traversal.

| Item | Included while | Opens |
| --- | --- | --- |
| Unanswered question | An explicit `question` has no `answer` whose `reply_to` names it, and its dispatch is still open | The recipient's existing member terminal; the row also provides the conversation read command and question ID |
| Report delivery | The durable report outbox receipt is not delivered, including pending, uncertain and manual-review states | Task delivery and health, focused on that receipt |
| Stopped member with queued work | A queued dispatch belongs to a currently stopped member | That member's existing terminal and start controls |
| Report awaiting acceptance | A reported task has a successful or legacy unspecified outcome and its current report is not accepted | The existing report, acceptance, feedback and code verification controls |
| Remote connection | Remote access is enabled and is logged out, reconnecting, revoked, or disconnected | The existing remote-access panel on the local computer |

This is a projection of existing facts, not another task lifecycle. A task can have
both an undelivered report and a report awaiting acceptance; these count as two
different matters. Accepting the report does not claim it was delivered. A note
that replies to a question does not count as an answer. Reported or cancelled
dispatches no longer contribute unanswered questions. Archived dispatches are
excluded. Remote reminders have no invented start time.

Opening a row never types into a terminal, starts a member, resends a report or
accepts it. Those decisions remain in their existing controls, with the same
permissions and confirmations. When a new report revision appears, the previously
expanded report closes. Open the new item to inspect that revision before accepting it. Time passing never turns these items into failed
tasks. Closing or refreshing the attention view makes no database changes.

## Read API

`GET /api/ui/workspaces/:workspaceId/attention` requires a UI session or a remote
device with read access to that workspace. Remote readers do not receive the
host-wide remote-connection item.

Query parameters:

- `filter`: `all` (default), `question`, `report_delivery`, `stopped_worker`,
  `acceptance`, or `remote_connection`.
- `limit`: an integer from 1 to 100; default 25.
- `cursor`: the previous response's opaque `next_cursor`, used with the same
  workspace and filter.

The response contains `items`, per-kind `counts`, `total`, `filtered_total`,
`next_cursor` and `generated_at`. Totals cover the full eligible result, not just
the returned page. All fields use snake_case. Each item includes its stable `id`,
`kind`, workspace, dispatch/root dispatch, agent, task preview, detail, state and
source timestamp. Where applicable it also includes `delivery_id` or `message_id`.
Question IDs use the message ID, delivery items use the receipt ID, stopped-work
items use the dispatch ID, and acceptance items include the report revision.

Pages sort by source timestamp and stable ID, oldest first. A cursor preserves the
initial time cutoff so newer facts wait for refresh. The projection remains live:
resolved items can disappear, and counts can fall during traversal. It is not a
frozen historical snapshot. An item that becomes eligible earlier in that order
is visible on refresh. No offset or second task-state table is maintained.

`GET /api/ui/workspaces/:workspaceId/dispatches/:dispatchId` retrieves the existing
serialized report directly, so older attention items do not depend on a recent
history limit. It has the same workspace read scope and returns 404 for a missing
workspace or dispatch. Both read endpoints return `Cache-Control: no-store`.

These counts describe current matters requiring attention. They are not unique
task counts, performance metrics, token usage or cost estimates.
