# Dynamic staffing and member retirement

Dynamic staffing is disabled by default. In the desktop member panel, open **Dynamic staffing and retired members**, select allowed CLI presets, set a temporary-member limit (default 2), enable staffing and save. Only an authenticated local user can change this policy. Existing manually created members remain persistent and do not use this temporary-member allowance. The global worker and process limits still apply.

The Orchestrator can inspect authorization and create members:

```sh
team staffing
team spawn --name Inspector --role reviewer --preset <allowed-id> --isolated
team spawn --name Builder --role coder --preset <allowed-id> --model <model-id> --no-start
team dismiss --worker <worker-id>
```

`spawn` supports `--description <text>`. It uses the same preset/model resolution, role description, worktree preparation, execution-policy checks and Skill readiness as desktop creation. It does not copy the Orchestrator's execution grants or Skills. A local user can save an automatic-member trust default for the same CLI installation and preset configuration; a matching new member receives its own audited grant before launch. This default does not reauthorize a revoked member. Arbitrary startup command overrides are rejected. Without `--isolated`, the new member uses the workspace directory; isolated creation requires a clean Git checkout. `--no-start` creates a stopped member for inspection and authorization before launch.

Creation returns a member record and `agent_start`. Check `agent_start.ok`, `error`, and any `queue_id`: a created member is not proof of a successful launch. For dynamic members, preparation errors are retained even when no worktree could be allocated, and a failed preparation cannot fall back to the shared directory. After inspecting its files, dismiss or explicitly delete the failed member and create a replacement.

Only the Orchestrator can use `spawn` and `dismiss`. Its dismissal authority covers temporary members. Turning staffing off blocks new spawns; existing members can finish and be dismissed. Stopped members still occupy a member slot. Retirement releases that slot, stops a pending/live process, hides the member from the active team and prevents dispatch, feedback reopening, manual startup and automatic recovery. It does not delete the member's reports, conversations, delivery evidence, launch configuration, Skill snapshots or worktree files. Dismissal is idempotent and permanent. Finish or explicitly cancel every open dispatch first; busy dismissal returns 409 without changing the member.

The desktop panel lists retired members and retained paths. Existing activity and delivery history remain available by their original IDs. Cleanup and destructive member deletion are separate, explicit operations.

HTTP payloads use snake_case:

- `GET/PUT /api/ui/workspaces/:workspaceId/staffing-policy`: `{ enabled, allowed_command_preset_ids, max_ephemeral_workers }`; local-user authorization required.
- `GET /api/team/staffing?project_id=...`: Orchestrator authorization required.
- `POST /api/team/spawn`: normal team credentials plus `{ name, role, command_preset_id, model?, description?, isolated?, autostart? }`.
- `POST /api/team/dismiss`: normal team credentials plus `{ worker_id }`.
- `GET /api/ui/workspaces/:workspaceId/members/retired` and `GET .../members/:workerId`: authenticated history access.
- `POST /api/ui/workspaces/:workspaceId/members/:workerId/retire`: local-user retirement, including persistent members.

Temporary-member payloads include `lifecycle_kind` and `spawned_by_agent_id`; retired records include `retired_at`. A pending or failed preparation includes `preparation_state` and, on failure, `preparation_error`. Agent status remains `idle`, `working`, or `stopped`.

SQLite serializes admission, retirement and dispatch creation. Retirement checks open dispatches and records the decision in one immediate transaction; dispatch insertion and report reopening check member availability inside their transaction. Git and PTY work runs outside database transactions. Startup rechecks the member after asynchronous preparation, and restart excludes retired or failed members while pending report delivery to the Orchestrator remains recoverable.
