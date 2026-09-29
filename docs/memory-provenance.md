# Memory provenance and prepared context

Manual notes retain their existing behavior. To create a memory from a reported dispatch or a protocol conversation, add `source_ref` to the authenticated memory creation request:

```json
{
  "kind": "decision",
  "body": "Preserve session cookie compatibility.",
  "source_ref": {
    "type": "dispatch_message",
    "source_id": "<dispatch-id>",
    "source_sequence": 3
  }
}
```

For a report, use `type: "dispatch"` and omit `source_sequence`. A conversation reference identifies a dispatch and its message sequence. Only sources in the requested workspace can be captured. Unsupported reference types, extra author/content fields inside the reference, missing messages and reports without report text are rejected. These references never resolve filesystem paths.

The server reads the canonical ledger record, derives its author from the dispatch recipient or message sender, and stores the author ID, name and role at capture time. Renaming or retiring a member leaves this snapshot intact. The excerpt is limited to 2,000 characters; the SHA-256 version covers the complete source record. A report version includes the task, report text and report revision; a conversation version includes its body, sender, recipient, kind and reply reference. This is a change detector, not a signature or proof that the contents are true.

Source-backed memories always start as `candidate`, even if an internal caller requests `active`. In the knowledge drawer, select **Candidates**, inspect **View sources**, and choose **Approve** or **Reject**. Only active, enabled entries can be selected for task context. Memory switches and character budgets continue to apply. Merely receiving a report or message does not create or approve a memory.

`GET /api/ui/workspaces/:workspaceId/memory/:memoryId/sources` returns the stored evidence and its current version state. Missing legacy metadata stays unknown. User-scoped memories can be used across workspaces, but evidence captured in another workspace is returned as `restricted`; its source reference, author, excerpt and hashes are withheld. Remote reads require the selected workspace scope and mutations retain the existing `memory_write` grant requirement.

Prepared context snapshots and their injection records commit together. When a dispatch ID is supplied it must identify a real dispatch for that workspace and target agent. The runtime supplies the actual dispatch ID. Context history preserves the selected memory revision and source snapshot, and flags subsequent changes. These records mean that content was selected for a pending payload; they do not confirm terminal delivery, model understanding or task completion. Delivery receipts remain separate.

Schema 64 adds only the source workspace snapshot. It leaves historical rows unchanged. Backup exports include canonical conversation messages as well as source evidence. Active and candidate report/conversation references prevent archival of their source task.
