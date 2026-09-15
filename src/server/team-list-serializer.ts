import type { TeamListItem, TeamListItemPayload } from '../shared/types.js'

export const serializeTeamListItem = ({
  avatar,
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
}: TeamListItem): TeamListItemPayload => ({
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
