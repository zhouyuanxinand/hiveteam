import type { TeamListItem, TeamListItemPayload } from '../shared/types.js'
import { serializeWorkerLifecycle } from '../shared/worker-lifecycle.js'

export const serializeTeamListItem = ({
  avatar,
  clarification,
  commandPresetId,
  id,
  lastPtyLine,
  name,
  pendingTaskCount,
  role,
  status,
  worktreeBranch,
  workingDirectory,
  worktreeError,
  ...lifecycle
}: TeamListItem): TeamListItemPayload => ({
  ...serializeWorkerLifecycle(lifecycle),
  ...(clarification
    ? {
        clarification: {
          dispatch_id: clarification.dispatchId,
          skill_name: clarification.skillName,
          active: clarification.active,
        },
      }
    : {}),
  ...(avatar ? { avatar } : {}),
  ...(worktreeBranch ? { worktree_branch: worktreeBranch } : {}),
  ...(workingDirectory ? { working_directory: workingDirectory } : {}),
  ...(worktreeError ? { worktree_error: worktreeError } : {}),
  id,
  name,
  role,
  status,
  pending_task_count: pendingTaskCount,
  last_pty_line: lastPtyLine ?? null,
  command_preset_id: commandPresetId ?? null,
})
