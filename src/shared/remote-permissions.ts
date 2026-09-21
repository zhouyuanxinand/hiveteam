export const REMOTE_ACTIONS = [
  'terminal_input',
  'terminal_resize',
  'agent_start',
  'agent_stop',
  'session_retry',
  'task_write',
  'workspace_manage',
  'workflow_manage',
  'memory_write',
  'skill_manage',
  'delivery_manage',
  'git_write',
  'git_publish',
] as const

export type RemoteAction = (typeof REMOTE_ACTIONS)[number]
export const REMOTE_GRANT_DURATION_MS = 10 * 60 * 1000

export interface RemoteAccessRequest {
  id: string
  device_id: string
  device_name: string
  workspace_id: string
  workspace_name: string
  actions: RemoteAction[]
  duration_ms: number
  requested_at: number
  expires_at: number
  status: 'pending' | 'approved' | 'rejected' | 'expired'
  resolved_at: number | null
  grant_id: string | null
}

export interface RemoteGrant {
  id: string
  request_id: string
  device_id: string
  workspace_id: string
  actions: RemoteAction[]
  approved_by: 'local_user'
  issued_at: number
  expires_at: number
  remaining_ms: number
  revoked_at: number | null
}

export interface RemoteAccess {
  device_id: string
  workspace_ids: string[]
  grants: RemoteGrant[]
  requests: RemoteAccessRequest[]
  server_time: number
  mode: 'read_only' | 'limited_write'
}

export interface RemoteTerminalPermissions {
  type: 'permissions'
  workspace_id: string
  actions: RemoteAction[]
  remaining_ms: number
}
