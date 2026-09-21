import type {
  RemoteAccess,
  RemoteAccessRequest,
  RemoteAction,
  RemoteGrant,
} from '../../../src/shared/remote-permissions.js'
import { apiFetch, readErrorMessage } from '../api.js'

export const isRemoteMode = () =>
  typeof window !== 'undefined' &&
  (window as Window & { __HIVE_REMOTE_MODE__?: boolean }).__HIVE_REMOTE_MODE__ === true

const request = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
  const response = await apiFetch(`/api/remote/${path}`, {
    method,
    cache: 'no-store',
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
  if (!response.ok) throw new Error(await readErrorMessage(response, 'Unable to update access'))
  return response.status === 204 ? (undefined as T) : ((await response.json()) as T)
}

export const getRemoteAccess = (deviceId?: string) =>
  request<RemoteAccess>(`access${deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : ''}`)

export const setRemoteReadScopes = (deviceId: string, workspaceIds: string[]) =>
  request<RemoteAccess>(`devices/${encodeURIComponent(deviceId)}/scopes`, 'PUT', {
    workspace_ids: workspaceIds,
  })

export const requestRemoteAccess = (workspaceId: string, actions: RemoteAction[]) =>
  request<RemoteAccessRequest>('access-requests', 'POST', {
    workspace_id: workspaceId,
    actions,
    duration_ms: 600_000,
  })

export const approveRemoteAccess = (requestId: string) =>
  request<RemoteGrant>(`access-requests/${encodeURIComponent(requestId)}/approve`, 'POST')

export const rejectRemoteAccess = (requestId: string) =>
  request<void>(`access-requests/${encodeURIComponent(requestId)}/reject`, 'POST')

export const revokeRemoteGrant = (grantId: string) =>
  request<void>(`grants/${encodeURIComponent(grantId)}/revoke`, 'POST')

export const remoteActionLabel = (action: RemoteAction, zh: boolean): string => {
  const labels: Record<RemoteAction, [string, string]> = {
    terminal_input: ['终端输入（可执行命令）', 'Terminal input (can execute commands)'],
    terminal_resize: ['调整终端大小', 'Resize terminals'],
    agent_start: ['启动成员', 'Start agents'],
    agent_stop: ['停止成员', 'Stop agents'],
    session_retry: ['恢复会话', 'Retry sessions'],
    task_write: ['编辑和派发任务', 'Edit and dispatch tasks'],
    workspace_manage: ['管理工作区和成员', 'Manage workspace and members'],
    workflow_manage: ['管理工作流', 'Manage workflows'],
    memory_write: ['修改记忆', 'Edit memory'],
    skill_manage: ['管理技能', 'Manage skills'],
    delivery_manage: ['交付与验证命令', 'Deliveries and verification commands'],
    git_write: ['Git 本地写入', 'Write local Git state'],
    git_publish: ['Git 远端发布', 'Publish to Git remotes'],
  }
  return labels[action][zh ? 0 : 1]
}
