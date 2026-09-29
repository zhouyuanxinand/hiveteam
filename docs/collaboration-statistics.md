# Collaboration statistics

Open **Activity center → Statistics**. The read-only workspace view supports the last 7 days, last 30 days, or all retained tasks. Refresh reads persisted facts; it never starts an agent, resends a message, accepts a report, or integrates code.

`GET /api/ui/workspaces/:workspaceId/collaboration-stats?period=7|30|all` requires the existing UI authentication or a remote device with workspace read access. The default period is `30`. The response uses snake_case and `Cache-Control: no-store`.

## Cohort and counts

The period selects root tasks by creation time, from the inclusive lower bound to the exclusive `generated_at` timestamp. All retained descendants belong to that root, even if a review was created later. Archived records remain included. Purged records are unavailable. If the root was purged but descendants remain, the family keeps its root ID and uses the earliest retained creation time.

- `root_tasks` counts families, while `dispatches` includes their review dispatches.
- `messages` counts structured dispatch conversation messages, excluding dispatch prompts, reports, status log entries, and raw terminal output.
- `reworks` counts reopening after a report. The existing revision counter and current state determine completed and currently open rework rounds: `max(report_revision - (status == reported ? 1 : 0), 0)`.
- `delivery_attempts` counts claimed attempts for dispatch, conversation, report, and cancellation receipts. `retries` counts attempts beyond the first on each receipt. A retry adds no task.

## Durations

Each metric first sums the applicable durations within one root family. The response then supplies `mean_ms`, nearest-rank `p50_ms` and `p95_ms`, `sample_count` and `missing_count`. Missing or reversed endpoints do not become zeros. Simultaneous endpoints produce a valid zero. A root contributes at most one sample to each metric; sums across concurrent reviews are cumulative durations, not elapsed wall time for the family.

| Metric | Persisted endpoints | Sample eligibility |
| --- | --- | --- |
| `queue` | Dispatch creation → submission | Every retained dispatch in the family has valid endpoints. |
| `execution` | Submission → latest report | Every retained dispatch is reported with valid endpoints. Includes waiting and rework; not CPU/model time. Cancelled work is missing. |
| `report_submission` | Report receipt creation → first terminal submission (or explicit receipt confirmation when no submission timestamp exists) | At least one report receipt exists and every retained report receipt has valid endpoints. Includes earlier report revisions. Manual resolution alone is not a submission timestamp. |
| `acceptance_to_integration` | Verification acceptance → its fast-forward integration; candidate acceptance → its recorded integration | At least one matching pair exists. Sums completed integration actions, including earlier revisions. Reports accepted without Git integration are missing. Does not measure publishing or deployment. |

A later rework or newly created review can make a previously complete family incomplete. The view is a current projection over retained facts, not a historical time-series snapshot or a forecast. No claim of savings is derived from these numbers.

## Prepared UTF-8 bytes

Schema 63 adds `delivery_payload_measurements`, keyed by receipt ID and attempt number with cascading deletion. Measurements contain only byte length and preparation time, not another prompt copy. Historical rows receive no fabricated backfill.

A durable attempt records `Buffer.byteLength(payload, 'utf8')` before terminal submission. This includes the prepared dispatch guidance, selected memory/skills and report/conversation protocol text. The Codex adapter measures the exact message including its receipt marker; bracketed-paste escape sequences and Enter keystrokes are excluded. Unsupported native adapters that never prepare a payload have no measurement. Resuming a previously pasted message without preparing again adds no byte sample.

Measurement covers durable dispatch, report, conversation and cancellation deliveries in the selected root families. Direct user input, startup prompts, ad hoc status/review feedback, and context added by the external CLI are outside this measure. It is not a total of all prompts or all model context.

Each attempt records once. An explicit retry that prepares content again adds another measurement, even if submission subsequently fails. Database failure prevents submission; the normal delivery retry rules remain in force.

`payload.total_bytes` is null when there are no measurements. `measured_attempts` and `unmeasured_attempts` cover claimed attempts. `pending_deliveries` separately counts pending receipts with no attempt yet. Missing measurements can mean historical data, preparation never reached, or a resumed checkpoint. Bytes describe prepared content, not wire traffic, model receipt, tokens, or monetary cost.
