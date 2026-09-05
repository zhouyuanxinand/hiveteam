import type {
  GitCommitPage,
  GitCommitSummary,
  GitRevertResult,
  GitSnapshotResult,
  WorkspaceGitStatus,
} from '../../src/shared/git.js'
import type { OpenTargetId, OpenWorkspaceErrorCode } from '../../src/shared/open-targets.js'
import type {
  TeamMemoryDreamReview,
  TeamMemoryDreamRun,
  TeamMemoryDreamSuggestion,
  TeamMemoryEntry,
  TeamMemoryKind,
  TeamMemoryProcedureRef,
  TeamMemoryScope,
  TeamMemoryStatus,
} from '../../src/shared/team-memory.js'
import type { TeamScenarioDefinition } from '../../src/shared/team-scenarios.js'
import type {
  AgentSummary,
  TeamListItem,
  TeamListItemPayload,
  WorkerRole,
  WorkspaceLanguage,
  WorkspaceRecoverySettings,
  WorkspaceSummary,
} from '../../src/shared/types.js'
import type { WorkspaceDocumentSummary } from '../../src/shared/workspace-documents.js'

export type { WorkspaceDocumentSummary } from '../../src/shared/workspace-documents.js'

export type {
  GitCommitPage,
  GitCommitSummary,
  GitRevertResult,
  GitSnapshotResult,
  OpenTargetId,
  OpenWorkspaceErrorCode,
  TeamMemoryDreamReview,
  TeamMemoryDreamRun,
  TeamMemoryDreamSuggestion,
  TeamMemoryEntry,
  TeamMemoryKind,
  TeamMemoryProcedureRef,
  TeamMemoryScope,
  TeamMemoryStatus,
  WorkspaceGitStatus,
}

const fromPayload = (payload: TeamListItemPayload): TeamListItem => ({
  ...(payload.avatar ? { avatar: payload.avatar } : {}),
  id: payload.id,
  name: payload.name,
  role: payload.role,
  status: payload.status,
  pendingTaskCount: payload.pending_task_count,
  ...(payload.last_pty_line ? { lastPtyLine: payload.last_pty_line } : {}),
  ...(payload.command_preset_id ? { commandPresetId: payload.command_preset_id } : {}),
})

const readErrorMessage = async (response: Response, fallback: string): Promise<string> => {
  try {
    const body = (await response.json()) as { error?: unknown }
    if (typeof body.error === 'string' && body.error.trim()) return body.error
  } catch {
    // Keep the original fallback when the server did not send a JSON error body.
  }
  return fallback
}

const isStaleUiSession = async (response: Response): Promise<boolean> => {
  if (response.status !== 403) return false
  try {
    const body = (await response.clone().json()) as { error?: unknown }
    return body.error === 'UI endpoint requires valid UI token'
  } catch {
    return false
  }
}

const isRemoteMode = () =>
  typeof window !== 'undefined' &&
  (window as Window & { __HIVE_REMOTE_MODE__?: boolean }).__HIVE_REMOTE_MODE__ === true

export const initializeUiSession = async (): Promise<void> => {
  if (isRemoteMode()) return
  const response = await fetch('/api/ui/session', { mode: 'same-origin' })
  if (!response.ok) {
    throw new Error('Failed to initialize UI session')
  }
  await response.json()
}

let uiSessionRefreshPromise: Promise<void> | null = null

const refreshUiSession = (): Promise<void> => {
  uiSessionRefreshPromise ??= initializeUiSession().finally(() => {
    uiSessionRefreshPromise = null
  })
  return uiSessionRefreshPromise
}

const apiFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const response = await fetch(input, init)
  if (!(await isStaleUiSession(response))) return response

  await refreshUiSession()
  return fetch(input, init)
}

export const listWorkspaces = async (): Promise<WorkspaceSummary[]> => {
  const response = await apiFetch('/api/workspaces')

  if (!response.ok) {
    throw new Error('Failed to load workspaces')
  }

  return (await response.json()) as WorkspaceSummary[]
}

interface WorkspaceRecoverySettingsPayload {
  auto_resume_on_restart: boolean
}

export const getWorkspaceRecoverySettings = async (
  workspaceId: string
): Promise<WorkspaceRecoverySettings> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/recovery-settings`)
  if (!response.ok) {
    throw new Error('Failed to load workspace recovery settings')
  }
  const payload = (await response.json()) as WorkspaceRecoverySettingsPayload
  return { autoResumeOnRestart: payload.auto_resume_on_restart }
}

export const setWorkspaceAutoResumeOnRestart = async (
  workspaceId: string,
  enabled: boolean
): Promise<WorkspaceRecoverySettings> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/recovery-settings`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ auto_resume_on_restart: enabled }),
  })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to save workspace recovery settings'))
  }
  const payload = (await response.json()) as WorkspaceRecoverySettingsPayload
  return { autoResumeOnRestart: payload.auto_resume_on_restart }
}

interface WorkspaceGitStatusPayload {
  auto_snapshot_enabled: boolean
  branch: string | null
  changed_file_count: number
  checked_at: number
  error: string | null
  head_sha: string | null
  is_dirty: boolean
  relative_path: string | null
  repo_root: string | null
  staged_file_count: number
  state: WorkspaceGitStatus['state']
  untracked_file_count: number
  workspace_id: string
  workspace_path: string
}

interface GitCommitPayload {
  author_email: string
  author_name: string
  authored_at: number
  changed_files: number
  committed_at: number
  deletions: number
  insertions: number
  is_hiveteam_snapshot: boolean
  message: string
  parents: string[]
  reverted_by_sha: string | null
  sha: string
  short_sha: string
  turn_id: string | null
}

interface GitCommitPagePayload {
  commits: GitCommitPayload[]
  has_more: boolean
  limit: number
  offset: number
}

const fromWorkspaceGitStatusPayload = (payload: WorkspaceGitStatusPayload): WorkspaceGitStatus => ({
  autoSnapshotEnabled: payload.auto_snapshot_enabled,
  branch: payload.branch,
  changedFileCount: payload.changed_file_count,
  checkedAt: payload.checked_at,
  error: payload.error,
  headSha: payload.head_sha,
  isDirty: payload.is_dirty,
  relativePath: payload.relative_path,
  repoRoot: payload.repo_root,
  stagedFileCount: payload.staged_file_count,
  state: payload.state,
  untrackedFileCount: payload.untracked_file_count,
  workspaceId: payload.workspace_id,
  workspacePath: payload.workspace_path,
})

const fromGitCommitPayload = (payload: GitCommitPayload): GitCommitSummary => ({
  authorEmail: payload.author_email,
  authorName: payload.author_name,
  authoredAt: payload.authored_at,
  changedFiles: payload.changed_files,
  committedAt: payload.committed_at,
  deletions: payload.deletions,
  insertions: payload.insertions,
  isHiveTeamSnapshot: payload.is_hiveteam_snapshot,
  message: payload.message,
  parents: payload.parents,
  revertedBySha: payload.reverted_by_sha,
  sha: payload.sha,
  shortSha: payload.short_sha,
  turnId: payload.turn_id,
})

const fromGitCommitPagePayload = (payload: GitCommitPagePayload): GitCommitPage => ({
  commits: payload.commits.map(fromGitCommitPayload),
  hasMore: payload.has_more,
  limit: payload.limit,
  offset: payload.offset,
})

export const getWorkspaceGitStatus = async (workspaceId: string): Promise<WorkspaceGitStatus> => {
  const response = await apiFetch(
    `/api/ui/workspaces/${encodeURIComponent(workspaceId)}/git/status`
  )
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to load Git status'))
  }
  return fromWorkspaceGitStatusPayload((await response.json()) as WorkspaceGitStatusPayload)
}

export const listWorkspaceGitCommits = async (
  workspaceId: string,
  input: { limit?: number; offset?: number } = {}
): Promise<GitCommitPage> => {
  const query = new URLSearchParams()
  query.set('limit', String(Math.min(100, Math.max(1, Math.floor(input.limit ?? 30)))))
  query.set('offset', String(Math.max(0, Math.floor(input.offset ?? 0))))
  const response = await apiFetch(
    `/api/ui/workspaces/${encodeURIComponent(workspaceId)}/git/commits?${query.toString()}`
  )
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to load Git history'))
  }
  return fromGitCommitPagePayload((await response.json()) as GitCommitPagePayload)
}

export const setWorkspaceGitAutoSnapshot = async (
  workspaceId: string,
  enabled: boolean
): Promise<WorkspaceGitStatus> => {
  const response = await apiFetch(
    `/api/ui/workspaces/${encodeURIComponent(workspaceId)}/git/settings`,
    {
      body: JSON.stringify({ auto_snapshot_enabled: enabled }),
      headers: { 'content-type': 'application/json' },
      method: 'PUT',
    }
  )
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to save Git settings'))
  }
  return fromWorkspaceGitStatusPayload((await response.json()) as WorkspaceGitStatusPayload)
}

export const initializeWorkspaceGit = async (workspaceId: string): Promise<WorkspaceGitStatus> => {
  const response = await apiFetch(
    `/api/ui/workspaces/${encodeURIComponent(workspaceId)}/git/initialize`,
    { method: 'POST' }
  )
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to initialize Git repository'))
  }
  return fromWorkspaceGitStatusPayload((await response.json()) as WorkspaceGitStatusPayload)
}

export const createWorkspaceGitSnapshot = async (
  workspaceId: string,
  input: { expectedHead?: string | null; message?: string; turnId?: string | null } = {}
): Promise<GitSnapshotResult> => {
  const response = await apiFetch(
    `/api/ui/workspaces/${encodeURIComponent(workspaceId)}/git/snapshots`,
    {
      body: JSON.stringify({
        ...(input.expectedHead !== undefined ? { expected_head: input.expectedHead } : {}),
        ...(input.message !== undefined ? { message: input.message } : {}),
        ...(input.turnId !== undefined ? { turn_id: input.turnId } : {}),
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    }
  )
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to create Git snapshot'))
  }
  const payload = (await response.json()) as {
    changed_files: number
    commit: GitCommitPayload | null
    deletions: number
    insertions: number
    outcome: GitSnapshotResult['outcome']
  }
  return {
    changedFiles: payload.changed_files,
    commit: payload.commit ? fromGitCommitPayload(payload.commit) : null,
    deletions: payload.deletions,
    insertions: payload.insertions,
    outcome: payload.outcome,
  }
}

export const revertWorkspaceGitCommit = async (
  workspaceId: string,
  commitSha: string,
  expectedHead?: string | null
): Promise<GitRevertResult> => {
  const response = await apiFetch(
    `/api/ui/workspaces/${encodeURIComponent(workspaceId)}/git/commits/${encodeURIComponent(commitSha)}/revert`,
    {
      body: JSON.stringify({
        ...(expectedHead !== undefined ? { expected_head: expectedHead } : {}),
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    }
  )
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to revert Git snapshot'))
  }
  const payload = (await response.json()) as {
    commit: GitCommitPayload
    reverted_sha: string
  }
  return {
    commit: fromGitCommitPayload(payload.commit),
    revertedSha: payload.reverted_sha,
  }
}

export type RemoteConnectionStatus =
  | 'disabled'
  | 'loggedOut'
  | 'connecting'
  | 'online'
  | 'reconnecting'
  | 'revoked'

export interface RemoteDevice {
  createdAt: number
  id: string
  lastActive: number | null
  name: string
  revokedAt: number | null
}

export interface RemoteStatus {
  connection: RemoteConnectionStatus
  connected: boolean
  daemonId: string | null
  devices: number
  enabled: boolean
  gatewayUrl: string | null
  loggedIn: boolean
  status: RemoteConnectionStatus
}

export interface RemotePairingTicket {
  code: string
  expiresAt: number
  pairingId: string
  qr: string
}

export interface RemotePendingPairing {
  deviceName: string | null
  expiresAt: number
  pairingId: string
  sas: string
}

export interface RemoteAuditRecord {
  action: string
  byteCount: number | null
  deviceId: string | null
  endpoint: string | null
  id: number
  preview: string | null
  rejectReason: string | null
  result: string
  ts: number
  workspaceId: string | null
}

interface RemoteStatusPayload {
  connection: RemoteConnectionStatus
  connected: boolean
  daemon_id: string | null
  devices: number
  enabled: boolean
  gateway_url: string | null
  logged_in: boolean
  status: RemoteConnectionStatus
}

interface RemoteDevicePayload {
  created_at: number
  id: string
  last_active: number | null
  name: string
  revoked_at: number | null
}

interface RemotePairingTicketPayload {
  code: string
  expires_at: number
  pairing_id: string
  qr: string
}

interface RemotePendingPairingPayload {
  device_name: string | null
  expires_at: number
  pairing_id: string
  sas: string
}

interface RemoteAuditRecordPayload {
  action: string
  byte_count: number | null
  device_id: string | null
  endpoint: string | null
  id: number
  preview: string | null
  reject_reason: string | null
  result: string
  ts: number
  workspace_id: string | null
}

const fromRemoteStatusPayload = (payload: RemoteStatusPayload): RemoteStatus => ({
  connection: payload.connection,
  connected: payload.connected,
  daemonId: payload.daemon_id,
  devices: payload.devices,
  enabled: payload.enabled,
  gatewayUrl: payload.gateway_url,
  loggedIn: payload.logged_in,
  status: payload.status,
})

const fromRemoteDevicePayload = (payload: RemoteDevicePayload): RemoteDevice => ({
  createdAt: payload.created_at,
  id: payload.id,
  lastActive: payload.last_active,
  name: payload.name,
  revokedAt: payload.revoked_at,
})

const fromRemotePendingPairingPayload = (
  payload: RemotePendingPairingPayload
): RemotePendingPairing => ({
  deviceName: payload.device_name,
  expiresAt: payload.expires_at,
  pairingId: payload.pairing_id,
  sas: payload.sas,
})

export const getRemoteStatus = async (): Promise<RemoteStatus> => {
  const response = await apiFetch('/api/remote/status', { mode: 'same-origin' })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to load remote access status'))
  }
  return fromRemoteStatusPayload((await response.json()) as RemoteStatusPayload)
}

export const setRemoteEnabled = async (enabled: boolean): Promise<RemoteStatus> => {
  const response = await apiFetch('/api/remote/enabled', {
    body: JSON.stringify({ enabled }),
    headers: { 'content-type': 'application/json' },
    method: 'PUT',
  })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to update remote access'))
  }
  const payload = (await response.json()) as {
    connected: boolean
    connection: RemoteConnectionStatus
    enabled: boolean
  }
  const current = await getRemoteStatus()
  return {
    ...current,
    connected: payload.connected,
    connection: payload.connection,
    enabled: payload.enabled,
    status: payload.connection,
  }
}

export const listRemoteDevices = async (includeRevoked = false): Promise<RemoteDevice[]> => {
  const query = includeRevoked ? '?include_revoked=true' : ''
  const response = await apiFetch(`/api/remote/devices${query}`, { mode: 'same-origin' })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to load remote devices'))
  }
  return ((await response.json()) as RemoteDevicePayload[]).map(fromRemoteDevicePayload)
}

export const beginRemotePairing = async (): Promise<RemotePairingTicket> => {
  const response = await apiFetch('/api/remote/pairings', {
    method: 'POST',
    mode: 'same-origin',
  })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to create pairing code'))
  }
  const payload = (await response.json()) as RemotePairingTicketPayload
  return {
    code: payload.code,
    expiresAt: payload.expires_at,
    pairingId: payload.pairing_id,
    qr: payload.qr,
  }
}

export const listRemotePairings = async (): Promise<RemotePendingPairing[]> => {
  const response = await apiFetch('/api/remote/pairings/pending', { mode: 'same-origin' })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to load pending pairings'))
  }
  return ((await response.json()) as RemotePendingPairingPayload[]).map(
    fromRemotePendingPairingPayload
  )
}

export const confirmRemotePairing = async (
  pairingId: string,
  name?: string
): Promise<RemoteDevice> => {
  const response = await apiFetch(`/api/remote/pairings/${encodeURIComponent(pairingId)}/confirm`, {
    body: JSON.stringify(name?.trim() ? { name: name.trim() } : {}),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to confirm remote device'))
  }
  const payload = (await response.json()) as { device: RemoteDevicePayload }
  return fromRemoteDevicePayload(payload.device)
}

export const rejectRemotePairing = async (pairingId: string): Promise<void> => {
  const response = await apiFetch(`/api/remote/pairings/${encodeURIComponent(pairingId)}/reject`, {
    method: 'POST',
  })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to reject remote device'))
  }
}

export const revokeRemoteDevice = async (deviceId: string): Promise<void> => {
  const response = await apiFetch(`/api/remote/devices/${encodeURIComponent(deviceId)}/revoke`, {
    method: 'POST',
  })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to revoke remote device'))
  }
}

export const getRemoteAudit = async (limit = 50): Promise<RemoteAuditRecord[]> => {
  const response = await apiFetch(`/api/remote/audit?limit=${Math.max(1, Math.min(limit, 200))}`, {
    mode: 'same-origin',
  })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to load remote audit'))
  }
  return ((await response.json()) as RemoteAuditRecordPayload[]).map((record) => ({
    action: record.action,
    byteCount: record.byte_count,
    deviceId: record.device_id,
    endpoint: record.endpoint,
    id: record.id,
    preview: record.preview,
    rejectReason: record.reject_reason,
    result: record.result,
    ts: record.ts,
    workspaceId: record.workspace_id,
  }))
}

export interface OrchestratorStartResult {
  ok: boolean
  error: string | null
  run_id: string | null
}

export interface CommandPreset {
  args: string[]
  available: boolean
  command: string
  displayName: string
  id: string
  installHint?: string | null
  supportsModel?: boolean
}

export interface RoleTemplate {
  description: string
  id: string
  isBuiltin: boolean
  name: string
  roleType: WorkerRole | 'orchestrator'
}

export interface RoleTemplateInput {
  description: string
  name: string
  roleType: WorkerRole | 'orchestrator'
}

interface CommandPresetPayload {
  args: string[]
  available: boolean
  command: string
  display_name: string
  id: string
  install_hint?: string | null
  supports_model: boolean
}

interface RoleTemplatePayload {
  description: string
  id: string
  is_builtin: boolean
  name: string
  role_type: WorkerRole | 'orchestrator'
}

const fromRoleTemplatePayload = (payload: RoleTemplatePayload): RoleTemplate => ({
  description: payload.description,
  id: payload.id,
  isBuiltin: payload.is_builtin,
  name: payload.name,
  roleType: payload.role_type,
})

const toRoleTemplateBody = (input: RoleTemplateInput) => ({
  name: input.name,
  role_type: input.roleType,
  description: input.description,
  default_command: '',
  default_args: [],
  default_env: {},
})

export interface AgentStartResult {
  error: string | null
  ok: boolean
  runId: string | null
}

interface AgentStartPayload {
  error: string | null
  ok: boolean
  run_id: string | null
}

export interface CreateWorkerResult {
  agentStart: AgentStartResult
  worker: TeamListItem
}

type CreateWorkerPayload = TeamListItemPayload & { agent_start?: AgentStartPayload }

export interface CreateWorkspaceResponse extends WorkspaceSummary {
  orchestrator_start: OrchestratorStartResult
}

export interface LocalRetentionDiagnostics {
  databaseBytes: number | null
  dataDir: string | null
  records: Record<string, number>
  schemaVersion: number
  storage: 'local'
}

export const createWorkspace = async (input: {
  language?: WorkspaceLanguage
  name: string
  path: string
  autostart_orchestrator?: boolean
  command_preset_id?: string | null
  startup_command?: string | null
}): Promise<CreateWorkspaceResponse> => {
  const response = await apiFetch('/api/workspaces', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to create workspace'))
  }

  return (await response.json()) as CreateWorkspaceResponse
}

export const getLocalRetentionDiagnostics = async (): Promise<LocalRetentionDiagnostics> => {
  const response = await apiFetch('/api/settings/local-retention-diagnostics')
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to load local diagnostics'))
  }
  return (await response.json()) as LocalRetentionDiagnostics
}

export const deleteWorkspace = async (workspaceId: string): Promise<void> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}`, { method: 'DELETE' })

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to delete workspace'))
  }
}

export const startAgentRun = async (
  workspaceId: string,
  agentId: string
): Promise<{ runId: string; threadId: string | null }> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/agents/${agentId}/start`, {
    method: 'POST',
  })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to start agent run'))
  }
  const body = (await response.json()) as { run_id: string; thread_id?: string | null }
  return { runId: body.run_id, threadId: body.thread_id ?? null }
}

export const stopAgentRun = async (runId: string): Promise<void> => {
  const response = await apiFetch(`/api/runtime/runs/${runId}/stop`, {
    method: 'POST',
  })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to stop agent run'))
  }
}

export const openModelPicker = async (
  runId: string,
  commandPresetId: string
): Promise<{ command: string; strategy: 'native-picker' | 'unsupported' }> => {
  const response = await apiFetch(`/api/runtime/runs/${runId}/model-picker`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ command_preset_id: commandPresetId }),
  })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to open the model picker'))
  }
  return (await response.json()) as { command: string; strategy: 'native-picker' | 'unsupported' }
}

export const restartAgentRun = async (
  workspaceId: string,
  agentId: string,
  runId: string
): Promise<{ runId: string }> => {
  // Best-effort stop: a 404 here often means the run already exited on its
  // own; either way we proceed to start a fresh one. Swallowed errors land in
  // the dev console for diagnosis.
  await stopAgentRun(runId).catch((error: unknown) => {
    console.error('[hive] swallowed:restartAgentRun.stop', error)
  })
  return startAgentRun(workspaceId, agentId)
}

export const getActiveWorkspaceId = async (): Promise<string | null> => {
  const response = await apiFetch('/api/settings/app-state/active_workspace_id')

  if (!response.ok) {
    throw new Error('Failed to load active workspace')
  }

  const payload = (await response.json()) as { key: string; value: string | null }
  return payload.value
}

export const saveActiveWorkspaceId = async (workspaceId: string | null): Promise<void> => {
  const response = await apiFetch('/api/settings/app-state/active_workspace_id', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value: workspaceId }),
  })

  if (!response.ok) {
    throw new Error('Failed to save active workspace')
  }
}

export const listWorkers = async (workspaceId: string): Promise<TeamListItem[]> => {
  const response = await apiFetch(`/api/ui/workspaces/${workspaceId}/team`, {
    mode: 'same-origin',
  })

  if (!response.ok) {
    throw new Error('Failed to load workers')
  }

  const payload = (await response.json()) as TeamListItemPayload[]
  return payload.map(fromPayload)
}

export const listWorkersForWorkspaces = async (
  workspaceIds: readonly string[]
): Promise<Record<string, TeamListItem[]>> => {
  const params = new URLSearchParams({ workspace_ids: workspaceIds.join(',') })
  const response = await apiFetch(`/api/ui/team?${params.toString()}`, {
    mode: 'same-origin',
  })

  if (!response.ok) {
    throw new Error('Failed to load workers')
  }

  const payload = (await response.json()) as {
    workers_by_workspace_id: Record<string, TeamListItemPayload[]>
  }
  return Object.fromEntries(
    Object.entries(payload.workers_by_workspace_id).map(([workspaceId, items]) => [
      workspaceId,
      items.map(fromPayload),
    ])
  )
}

export interface DispatchSummary {
  artifacts: string[]
  attemptCount?: number
  createdAt: number
  deliveredAt: number | null
  fromAgentId: string | null
  id: string
  lastAttemptAt?: number
  lastError?: string
  reportDelivery?: {
    attemptCount: number
    deliveredAt: number | null
    lastAttemptAt: number | null
    lastError: string | null
  }
  reportedAt: number | null
  reportText: string | null
  state: 'cancelled' | 'failed' | 'queued' | 'reported' | 'submitted'
  submittedAt: number | null
  text: string
  toAgentId: string
  workspaceId: string
}

interface DispatchSummaryPayload {
  artifacts: string[]
  attempt_count?: number
  created_at: number
  delivered_at: number | null
  from_agent_id: string | null
  id: string
  last_attempt_at?: number
  last_error?: string
  report_delivery?: {
    attempt_count: number
    delivered_at: number | null
    last_attempt_at: number | null
    last_error: string | null
  }
  reported_at: number | null
  report_text: string | null
  state: DispatchSummary['state']
  submitted_at: number | null
  text: string
  to_agent_id: string
  workspace_id: string
}

const fromDispatchPayload = (payload: DispatchSummaryPayload): DispatchSummary => ({
  artifacts: payload.artifacts,
  ...(payload.attempt_count !== undefined ? { attemptCount: payload.attempt_count } : {}),
  createdAt: payload.created_at,
  deliveredAt: payload.delivered_at,
  fromAgentId: payload.from_agent_id,
  id: payload.id,
  ...(payload.last_attempt_at !== undefined ? { lastAttemptAt: payload.last_attempt_at } : {}),
  ...(payload.last_error !== undefined ? { lastError: payload.last_error } : {}),
  ...(payload.report_delivery
    ? {
        reportDelivery: {
          attemptCount: payload.report_delivery.attempt_count,
          deliveredAt: payload.report_delivery.delivered_at,
          lastAttemptAt: payload.report_delivery.last_attempt_at,
          lastError: payload.report_delivery.last_error,
        },
      }
    : {}),
  reportedAt: payload.reported_at,
  reportText: payload.report_text,
  state: payload.state,
  submittedAt: payload.submitted_at,
  text: payload.text,
  toAgentId: payload.to_agent_id,
  workspaceId: payload.workspace_id,
})

export const listWorkspaceDispatches = async (
  workspaceId: string,
  input: { limit?: number; state?: DispatchSummary['state'] } = {}
): Promise<DispatchSummary[]> => {
  const query = new URLSearchParams()
  if (input.limit !== undefined) query.set('limit', String(input.limit))
  if (input.state) query.set('state', input.state)
  const suffix = query.toString() ? `?${query.toString()}` : ''
  const response = await apiFetch(`/api/ui/workspaces/${workspaceId}/dispatches${suffix}`)
  if (!response.ok) throw new Error(await readErrorMessage(response, 'Failed to load dispatches'))
  return ((await response.json()) as DispatchSummaryPayload[]).map(fromDispatchPayload)
}

export interface WorkspaceActivityMessage {
  artifacts?: string[]
  createdAt: number
  from?: string | null
  status?: string | null
  text: string
  to?: string
  type: string
}

export interface WorkspaceActivityTerminalRun {
  agent_id: string
  agent_name: string
  run_id: string
  status: string
  terminal_input_profile: string
  thread_id?: string | null
}

export interface WorkspaceActivityBundle {
  dispatches: DispatchSummary[]
  generatedAt: number
  git: WorkspaceGitStatus | { error: string; state: 'error' } | null
  gitCommits: GitCommitSummary[]
  messages: WorkspaceActivityMessage[]
  terminalRuns: WorkspaceActivityTerminalRun[]
  workers: TeamListItem[]
  workspace: WorkspaceSummary
}

interface WorkspaceActivityPayload {
  dispatches: DispatchSummaryPayload[]
  generated_at: number
  git: WorkspaceGitStatusPayload | { error?: string; state: 'error' } | null
  git_commits: GitCommitPayload[]
  messages: Array<{
    artifacts?: unknown
    created_at: number
    from?: unknown
    status?: unknown
    text: string
    to?: unknown
    type: string
  }>
  terminal_runs: WorkspaceActivityTerminalRun[]
  workers: TeamListItemPayload[]
  workspace: WorkspaceSummary
}

const fromActivityMessage = (
  payload: WorkspaceActivityPayload['messages'][number]
): WorkspaceActivityMessage => ({
  ...(Array.isArray(payload.artifacts)
    ? { artifacts: payload.artifacts.filter((item): item is string => typeof item === 'string') }
    : {}),
  createdAt: payload.created_at,
  ...(typeof payload.from === 'string' || payload.from === null ? { from: payload.from } : {}),
  ...(typeof payload.status === 'string' || payload.status === null
    ? { status: payload.status }
    : {}),
  text: payload.text,
  ...(typeof payload.to === 'string' ? { to: payload.to } : {}),
  type: payload.type,
})

export const getWorkspaceActivity = async (
  workspaceId: string,
  limit = 50
): Promise<WorkspaceActivityBundle> => {
  const query = new URLSearchParams({
    limit: String(Math.min(100, Math.max(1, Math.floor(limit)))),
  })
  const response = await apiFetch(
    `/api/ui/workspaces/${encodeURIComponent(workspaceId)}/activity?${query.toString()}`
  )
  if (!response.ok) throw new Error(await readErrorMessage(response, 'Failed to load activity'))
  const payload = (await response.json()) as WorkspaceActivityPayload
  return {
    dispatches: payload.dispatches.map(fromDispatchPayload),
    generatedAt: payload.generated_at,
    git:
      payload.git && 'workspace_id' in payload.git
        ? fromWorkspaceGitStatusPayload(payload.git)
        : payload.git
          ? { error: payload.git.error ?? 'Git status unavailable', state: 'error' as const }
          : null,
    gitCommits: payload.git_commits.map(fromGitCommitPayload),
    messages: payload.messages.map(fromActivityMessage),
    terminalRuns: payload.terminal_runs,
    workers: payload.workers.map(fromPayload),
    workspace: payload.workspace,
  }
}

export interface TeamScenarioPreset {
  available: boolean
  displayName: string
  id: string
  installHint: string | null
}

export interface TeamScenarioCatalog {
  presets: TeamScenarioPreset[]
  scenarios: TeamScenarioDefinition[]
}

interface TeamScenarioCatalogPayload {
  presets: Array<{
    available: boolean
    display_name: string
    id: string
    install_hint: string | null
  }>
  scenarios: TeamScenarioDefinition[]
}

export class TeamScenarioLaunchError extends Error {
  readonly missing: TeamScenarioPreset[]

  constructor(message: string, missing: TeamScenarioPreset[] = []) {
    super(message)
    this.name = 'TeamScenarioLaunchError'
    this.missing = missing
  }
}

export const listTeamScenarios = async (): Promise<TeamScenarioCatalog> => {
  const response = await apiFetch('/api/ui/team-scenarios')
  if (!response.ok)
    throw new Error(await readErrorMessage(response, 'Failed to load team scenarios'))
  const payload = (await response.json()) as TeamScenarioCatalogPayload
  return {
    presets: payload.presets.map((preset) => ({
      available: preset.available,
      displayName: preset.display_name,
      id: preset.id,
      installHint: preset.install_hint,
    })),
    scenarios: payload.scenarios,
  }
}

export const launchTeamScenario = async (
  workspaceId: string,
  scenarioId: string,
  input: { autostart?: boolean; commandPresetId?: string } = {}
): Promise<{ created: string[]; reused: string[]; workers: TeamListItem[] }> => {
  const response = await apiFetch(
    `/api/ui/workspaces/${encodeURIComponent(workspaceId)}/team-scenarios/${encodeURIComponent(scenarioId)}`,
    {
      body: JSON.stringify({
        ...(input.autostart !== undefined ? { autostart: input.autostart } : {}),
        ...(input.commandPresetId ? { command_preset_id: input.commandPresetId } : {}),
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    }
  )
  if (!response.ok) {
    let payload: { error?: unknown; missing?: TeamScenarioCatalogPayload['presets'] } = {}
    try {
      payload = (await response.json()) as typeof payload
    } catch {
      // Fall through to the normal status message.
    }
    const missing = (payload.missing ?? []).map((preset) => ({
      available: false,
      displayName: preset.display_name,
      id: preset.id,
      installHint: preset.install_hint,
    }))
    throw new TeamScenarioLaunchError(
      typeof payload.error === 'string'
        ? payload.error
        : `Failed to launch team scenario (${response.status})`,
      missing
    )
  }
  const payload = (await response.json()) as {
    created: string[]
    reused: string[]
    workers: TeamListItemPayload[]
  }
  return {
    created: payload.created,
    reused: payload.reused,
    workers: payload.workers.map(fromPayload),
  }
}

interface TeamMemoryPayload {
  body: string
  confidence: number
  created_at: number
  created_by_agent_id: string | null
  created_by_agent_name: string | null
  disabled: boolean
  id: string
  kind: TeamMemoryKind
  last_injected_at: number | null
  pinned: boolean
  procedure_ref?: TeamMemoryProcedureRef | null
  scope: TeamMemoryScope
  source: TeamMemoryEntry['source']
  status: TeamMemoryStatus
  tags: string[]
  updated_at: number
  workspace_id: string | null
}

const fromTeamMemoryPayload = (payload: TeamMemoryPayload): TeamMemoryEntry => ({
  body: payload.body,
  confidence: payload.confidence,
  createdAt: payload.created_at,
  createdByAgentId: payload.created_by_agent_id,
  createdByAgentName: payload.created_by_agent_name,
  disabled: payload.disabled,
  id: payload.id,
  kind: payload.kind,
  lastInjectedAt: payload.last_injected_at,
  pinned: payload.pinned,
  procedureRef: payload.procedure_ref ?? null,
  scope: payload.scope,
  source: payload.source,
  status: payload.status,
  tags: payload.tags,
  updatedAt: payload.updated_at,
  workspaceId: payload.workspace_id,
})

export const listTeamMemory = async (
  workspaceId: string,
  input: { query?: string; status?: TeamMemoryStatus } = {}
): Promise<TeamMemoryEntry[]> => {
  const query = new URLSearchParams({ limit: '50' })
  if (input.query?.trim()) query.set('query', input.query.trim())
  if (input.status) query.set('status', input.status)
  const response = await apiFetch(`/api/ui/workspaces/${workspaceId}/memory?${query}`)
  if (!response.ok) throw new Error(await readErrorMessage(response, 'Failed to load team memory'))
  return ((await response.json()) as TeamMemoryPayload[]).map(fromTeamMemoryPayload)
}

export const createTeamMemory = async (
  workspaceId: string,
  input: {
    body: string
    kind: TeamMemoryKind
    procedureRef?: TeamMemoryProcedureRef | null
    scope: TeamMemoryScope
    tags: string[]
  }
): Promise<TeamMemoryEntry> => {
  const { procedureRef, ...body } = input
  const response = await apiFetch(`/api/ui/workspaces/${workspaceId}/memory`, {
    body: JSON.stringify({
      ...body,
      ...(procedureRef !== undefined ? { procedure_ref: procedureRef } : {}),
    }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  if (!response.ok) throw new Error(await readErrorMessage(response, 'Failed to save team memory'))
  return fromTeamMemoryPayload((await response.json()) as TeamMemoryPayload)
}

export const updateTeamMemory = async (
  workspaceId: string,
  memoryId: string,
  input: Partial<{
    body: string
    disabled: boolean
    kind: TeamMemoryKind
    pinned: boolean
    procedureRef: TeamMemoryProcedureRef | null
    scope: TeamMemoryScope
    status: TeamMemoryStatus
    tags: string[]
  }>
): Promise<TeamMemoryEntry> => {
  const { procedureRef, ...body } = input
  const response = await apiFetch(
    `/api/ui/workspaces/${workspaceId}/memory/${encodeURIComponent(memoryId)}`,
    {
      body: JSON.stringify({
        ...body,
        ...(procedureRef !== undefined ? { procedure_ref: procedureRef } : {}),
      }),
      headers: { 'content-type': 'application/json' },
      method: 'PATCH',
    }
  )
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to update team memory'))
  }
  return fromTeamMemoryPayload((await response.json()) as TeamMemoryPayload)
}

export const getTeamMemorySettings = async (
  workspaceId: string
): Promise<{ dreamEnabled: boolean; enabled: boolean }> => {
  const response = await apiFetch(`/api/ui/workspaces/${workspaceId}/memory/settings`)
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to load memory settings'))
  }
  const payload = (await response.json()) as { dream_enabled?: unknown; enabled: boolean }
  return {
    dreamEnabled: payload.dream_enabled === true,
    enabled: payload.enabled,
  }
}

export const setTeamMemoryEnabled = async (
  workspaceId: string,
  enabled: boolean
): Promise<void> => {
  const response = await apiFetch(`/api/ui/workspaces/${workspaceId}/memory/settings`, {
    body: JSON.stringify({ enabled }),
    headers: { 'content-type': 'application/json' },
    method: 'PUT',
  })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to update memory settings'))
  }
}

export const setTeamMemoryDreamEnabled = async (
  workspaceId: string,
  enabled: boolean
): Promise<void> => {
  const response = await apiFetch(`/api/ui/workspaces/${workspaceId}/memory/settings`, {
    body: JSON.stringify({ dream_enabled: enabled }),
    headers: { 'content-type': 'application/json' },
    method: 'PUT',
  })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to update Dream schedule'))
  }
}

interface TeamMemoryDreamSuggestionPayload {
  body: string
  kind: TeamMemoryKind
  procedure_ref?: TeamMemoryProcedureRef | null
  scope: TeamMemoryScope
  source_memory_ids: string[]
  tags: string[]
}

interface TeamMemoryDreamPayload {
  created_at: number
  created_memory_ids: string[]
  execution_error?: string | null
  execution_status?: TeamMemoryDreamRun['executionStatus']
  id: string
  orchestrator_run_id?: string | null
  rolled_back_at: number | null
  reviews?: TeamMemoryDreamReviewPayload[]
  status: TeamMemoryDreamRun['status']
  submitted_at: number | null
  suggestions: TeamMemoryDreamSuggestionPayload[]
  workspace_id: string
}

interface TeamMemoryDreamReviewPayload {
  artifacts: string[]
  created_at: number
  dispatch_id: string
  dream_id: string
  id: string
  review_text: string | null
  status: TeamMemoryDreamReview['status']
  suggestions: TeamMemoryDreamSuggestionPayload[]
  updated_at: number
  worker_id: string
  workspace_id: string
}

const fromDreamReviewPayload = (payload: TeamMemoryDreamReviewPayload): TeamMemoryDreamReview => ({
  artifacts: payload.artifacts,
  createdAt: payload.created_at,
  dispatchId: payload.dispatch_id,
  dreamId: payload.dream_id,
  id: payload.id,
  reviewText: payload.review_text,
  status: payload.status,
  suggestions: payload.suggestions.map((suggestion) => ({
    body: suggestion.body,
    kind: suggestion.kind,
    procedureRef: suggestion.procedure_ref ?? null,
    scope: suggestion.scope,
    sourceMemoryIds: suggestion.source_memory_ids,
    tags: suggestion.tags,
  })),
  updatedAt: payload.updated_at,
  workerId: payload.worker_id,
  workspaceId: payload.workspace_id,
})

const fromDreamPayload = (payload: TeamMemoryDreamPayload): TeamMemoryDreamRun => ({
  createdAt: payload.created_at,
  createdMemoryIds: payload.created_memory_ids,
  executionError: payload.execution_error ?? null,
  executionStatus: payload.execution_status ?? 'queued',
  id: payload.id,
  orchestratorRunId: payload.orchestrator_run_id ?? null,
  rolledBackAt: payload.rolled_back_at,
  reviews: (payload.reviews ?? []).map(fromDreamReviewPayload),
  status: payload.status,
  submittedAt: payload.submitted_at,
  suggestions: payload.suggestions.map(
    (suggestion): TeamMemoryDreamSuggestion => ({
      body: suggestion.body,
      kind: suggestion.kind,
      procedureRef: suggestion.procedure_ref ?? null,
      scope: suggestion.scope,
      sourceMemoryIds: suggestion.source_memory_ids,
      tags: suggestion.tags,
    })
  ),
  workspaceId: payload.workspace_id,
})

export const listTeamMemoryDreams = async (workspaceId: string): Promise<TeamMemoryDreamRun[]> => {
  const response = await apiFetch(`/api/ui/workspaces/${workspaceId}/memory/dream`)
  if (!response.ok) throw new Error(await readErrorMessage(response, 'Failed to load Dream runs'))
  return ((await response.json()) as TeamMemoryDreamPayload[]).map(fromDreamPayload)
}

export const createTeamMemoryDream = async (workspaceId: string): Promise<TeamMemoryDreamRun> => {
  const response = await apiFetch(`/api/ui/workspaces/${workspaceId}/memory/dream`, {
    method: 'POST',
  })
  if (!response.ok)
    throw new Error(await readErrorMessage(response, 'Failed to prepare Dream review'))
  return fromDreamPayload((await response.json()) as TeamMemoryDreamPayload)
}

export const updateTeamMemoryDream = async (
  workspaceId: string,
  dreamId: string,
  suggestions: TeamMemoryDreamSuggestion[]
): Promise<TeamMemoryDreamRun> => {
  const response = await apiFetch(
    `/api/ui/workspaces/${workspaceId}/memory/dream/${encodeURIComponent(dreamId)}`,
    {
      body: JSON.stringify({
        suggestions: suggestions.map((suggestion) => ({
          body: suggestion.body,
          kind: suggestion.kind,
          procedure_ref: suggestion.procedureRef,
          scope: suggestion.scope,
          source_memory_ids: suggestion.sourceMemoryIds,
          tags: suggestion.tags,
        })),
      }),
      headers: { 'content-type': 'application/json' },
      method: 'PATCH',
    }
  )
  if (!response.ok) throw new Error(await readErrorMessage(response, 'Failed to save Dream review'))
  return fromDreamPayload((await response.json()) as TeamMemoryDreamPayload)
}

export const submitTeamMemoryDream = async (
  workspaceId: string,
  dreamId: string
): Promise<TeamMemoryDreamRun> => {
  const response = await apiFetch(
    `/api/ui/workspaces/${workspaceId}/memory/dream/${encodeURIComponent(dreamId)}/submit`,
    {
      body: JSON.stringify({ orchestrator_id: `${workspaceId}:orchestrator` }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    }
  )
  if (!response.ok)
    throw new Error(await readErrorMessage(response, 'Only the Orchestrator can submit Dream'))
  return fromDreamPayload((await response.json()) as TeamMemoryDreamPayload)
}

export const rollbackTeamMemoryDream = async (
  workspaceId: string,
  dreamId: string
): Promise<TeamMemoryDreamRun> => {
  const response = await apiFetch(
    `/api/ui/workspaces/${workspaceId}/memory/dream/${encodeURIComponent(dreamId)}/rollback`,
    { method: 'POST' }
  )
  if (!response.ok) throw new Error(await readErrorMessage(response, 'Failed to roll back Dream'))
  return fromDreamPayload((await response.json()) as TeamMemoryDreamPayload)
}

export const listTeamMemoryDreamReviews = async (
  workspaceId: string,
  dreamId: string
): Promise<TeamMemoryDreamReview[]> => {
  const response = await apiFetch(
    `/api/ui/workspaces/${workspaceId}/memory/dream/${encodeURIComponent(dreamId)}/reviews`
  )
  if (!response.ok)
    throw new Error(await readErrorMessage(response, 'Failed to load Dream reviews'))
  return ((await response.json()) as TeamMemoryDreamReviewPayload[]).map(fromDreamReviewPayload)
}

export const requestTeamMemoryDreamReview = async (
  workspaceId: string,
  dreamId: string,
  workerId: string
): Promise<TeamMemoryDreamReview> => {
  const response = await apiFetch(
    `/api/ui/workspaces/${workspaceId}/memory/dream/${encodeURIComponent(dreamId)}/reviews`,
    {
      body: JSON.stringify({ worker_id: workerId }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    }
  )
  if (!response.ok)
    throw new Error(await readErrorMessage(response, 'Failed to request Dream review'))
  return fromDreamReviewPayload((await response.json()) as TeamMemoryDreamReviewPayload)
}

export interface WorkflowDefinition {
  description: string
  id: string
  name: string
  path: string
  runnable: boolean
  updatedAt: number
  validationError: string | null
}

interface WorkflowDefinitionPayload {
  description: string
  id: string
  name: string
  path: string
  runnable?: boolean
  updated_at: number
  validation_error?: string
}

export interface WorkflowRunStep {
  artifacts: string[]
  dispatchId: string | null
  error: string | null
  id: string
  needs: string[]
  reportText: string | null
  status: 'completed' | 'failed' | 'queued' | 'running' | 'stopped'
  task: string
  worker: string
}

export interface WorkflowRun {
  createdAt: number
  endedAt: number | null
  error: string | null
  id: string
  name: string
  startedAt: number | null
  status: 'completed' | 'failed' | 'running' | 'stopped'
  steps: WorkflowRunStep[]
  updatedAt: number
  workflowId: string
  workspaceId: string
}

interface WorkflowRunPayload {
  created_at: number
  ended_at: number | null
  error: string | null
  id: string
  name: string
  started_at: number | null
  status: WorkflowRun['status']
  steps: Array<{
    artifacts: string[]
    dispatch_id: string | null
    error: string | null
    id: string
    needs: string[]
    report_text: string | null
    status: WorkflowRunStep['status']
    task: string
    worker: string
  }>
  updated_at: number
  workflow_id: string
  workspace_id: string
}

interface WorkspaceWorkflowStatePayload {
  runs: WorkflowRunPayload[]
  schedules: unknown[]
  workflows: WorkflowDefinitionPayload[]
}

export interface WorkspaceWorkflowState {
  runs: WorkflowRun[]
  schedules: unknown[]
  workflows: WorkflowDefinition[]
}

const fromWorkflowDefinitionPayload = (
  workflow: WorkflowDefinitionPayload
): WorkflowDefinition => ({
  description: workflow.description,
  id: workflow.id,
  name: workflow.name,
  path: workflow.path,
  runnable: workflow.runnable ?? false,
  updatedAt: workflow.updated_at,
  validationError: workflow.validation_error ?? null,
})

const fromWorkflowRunPayload = (run: WorkflowRunPayload): WorkflowRun => ({
  createdAt: run.created_at,
  endedAt: run.ended_at,
  error: run.error,
  id: run.id,
  name: run.name,
  startedAt: run.started_at,
  status: run.status,
  steps: run.steps.map((step) => ({
    artifacts: step.artifacts,
    dispatchId: step.dispatch_id,
    error: step.error,
    id: step.id,
    needs: step.needs,
    reportText: step.report_text,
    status: step.status,
    task: step.task,
    worker: step.worker,
  })),
  updatedAt: run.updated_at,
  workflowId: run.workflow_id,
  workspaceId: run.workspace_id,
})

export const listWorkspaceWorkflowState = async (
  workspaceId: string
): Promise<WorkspaceWorkflowState> => {
  const response = await apiFetch(`/api/ui/workspaces/${workspaceId}/workflows`)
  if (!response.ok) throw new Error(await readErrorMessage(response, 'Failed to load workflows'))
  const payload = (await response.json()) as WorkspaceWorkflowStatePayload
  return {
    runs: payload.runs.map(fromWorkflowRunPayload),
    schedules: payload.schedules,
    workflows: payload.workflows.map(fromWorkflowDefinitionPayload),
  }
}

export const listWorkspaceWorkflows = async (
  workspaceId: string
): Promise<WorkflowDefinition[]> => {
  return (await listWorkspaceWorkflowState(workspaceId)).workflows
}

export const runWorkspaceWorkflow = async (
  workspaceId: string,
  workflowId: string
): Promise<WorkflowRun> => {
  const response = await apiFetch(`/api/ui/workspaces/${workspaceId}/workflows/runs`, {
    body: JSON.stringify({ workflow_id: workflowId }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  if (!response.ok) throw new Error(await readErrorMessage(response, 'Failed to start workflow'))
  return fromWorkflowRunPayload((await response.json()) as WorkflowRunPayload)
}

export const stopWorkspaceWorkflow = async (
  workspaceId: string,
  runId: string
): Promise<WorkflowRun> => {
  const response = await apiFetch(
    `/api/ui/workspaces/${workspaceId}/workflows/runs/${encodeURIComponent(runId)}/stop`,
    { method: 'POST' }
  )
  if (!response.ok) throw new Error(await readErrorMessage(response, 'Failed to stop workflow'))
  return fromWorkflowRunPayload((await response.json()) as WorkflowRunPayload)
}

export const listCommandPresets = async (): Promise<CommandPreset[]> => {
  const response = await apiFetch('/api/settings/command-presets')

  if (!response.ok) {
    throw new Error('Failed to load command presets')
  }

  return ((await response.json()) as CommandPresetPayload[]).map((preset) => ({
    args: preset.args,
    available: preset.available,
    command: preset.command,
    displayName: preset.display_name,
    id: preset.id,
    installHint: preset.install_hint ?? null,
    supportsModel: preset.supports_model,
  }))
}

export type TerminalInputProfile = 'default' | 'opencode'

export interface TerminalRunSummary {
  agent_id: string
  agent_name: string
  run_id: string
  status: string
  /** Native CLI session/thread id; stable across process restarts when supported. */
  thread_id?: string | null
  terminal_input_profile?: TerminalInputProfile
}

export const workspaceShellAgentId = (workspaceId: string): string => `${workspaceId}:shell`

export const isWorkspaceShellRun = (run: TerminalRunSummary, workspaceId: string): boolean =>
  run.agent_id === workspaceShellAgentId(workspaceId)

export const startWorkspaceShell = async (workspaceId: string): Promise<TerminalRunSummary> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/shell/start`, {
    method: 'POST',
  })

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to start workspace terminal'))
  }

  return (await response.json()) as TerminalRunSummary
}

export const closeWorkspaceShell = async (workspaceId: string, runId: string): Promise<void> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/shell/${runId}`, {
    method: 'DELETE',
  })

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to close workspace terminal'))
  }
}

export const listRoleTemplates = async (): Promise<RoleTemplate[]> => {
  const response = await apiFetch('/api/settings/role-templates', {
    mode: 'same-origin',
  })

  if (!response.ok) {
    throw new Error('Failed to load role templates')
  }

  const payload = (await response.json()) as RoleTemplatePayload[]
  return payload.map(fromRoleTemplatePayload)
}

export const createRoleTemplate = async (input: RoleTemplateInput): Promise<RoleTemplate> => {
  const response = await apiFetch('/api/settings/role-templates', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(toRoleTemplateBody(input)),
  })

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to create role template'))
  }

  return fromRoleTemplatePayload((await response.json()) as RoleTemplatePayload)
}

export const updateRoleTemplate = async (
  templateId: string,
  input: RoleTemplateInput
): Promise<RoleTemplate> => {
  const response = await apiFetch(`/api/settings/role-templates/${templateId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(toRoleTemplateBody(input)),
  })

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to update role template'))
  }

  return fromRoleTemplatePayload((await response.json()) as RoleTemplatePayload)
}

export const deleteRoleTemplate = async (templateId: string): Promise<void> => {
  const response = await apiFetch(`/api/settings/role-templates/${templateId}`, {
    method: 'DELETE',
  })

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to delete role template'))
  }
}

export type MarketplaceLanguage = 'en' | 'zh'

export interface MarketplaceAgentEntry {
  path: string
  category: string
  name: string
  displayName?: string
  nameOverflows?: boolean
  description: string
  emoji: string | null
  color: string | null
  vibe: string | null
}

export interface MarketplaceManifest {
  source: {
    repo: string
    commit: string
    fetched_at: string
  }
  language: MarketplaceLanguage
  categories: string[]
  agents: MarketplaceAgentEntry[]
}

export interface MarketplaceAgentDetail {
  path: string
  frontmatter: Record<string, unknown>
  body: string
}

export const fetchMarketplaceManifest = async (
  lang: MarketplaceLanguage
): Promise<MarketplaceManifest> => {
  const response = await apiFetch(`/api/marketplace/manifest?lang=${lang}`, {
    mode: 'same-origin',
  })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to load marketplace manifest'))
  }
  return (await response.json()) as MarketplaceManifest
}

export const fetchMarketplaceAgent = async (
  lang: MarketplaceLanguage,
  path: string
): Promise<MarketplaceAgentDetail> => {
  const response = await apiFetch(
    `/api/marketplace/agent?lang=${lang}&path=${encodeURIComponent(path)}`,
    { mode: 'same-origin' }
  )
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to load marketplace agent'))
  }
  return (await response.json()) as MarketplaceAgentDetail
}

export const listTerminalRuns = async (workspaceId: string): Promise<TerminalRunSummary[]> => {
  const response = await apiFetch(`/api/ui/workspaces/${workspaceId}/runs`, {
    mode: 'same-origin',
  })

  if (!response.ok) {
    throw new Error('Failed to load terminal runs')
  }

  return (await response.json()) as TerminalRunSummary[]
}

export const createWorker = async (
  workspaceId: string,
  input: Pick<AgentSummary, 'name'> & {
    autostart?: boolean
    avatar?: string | null
    command_preset_id?: string | null
    description?: string
    model?: string | null
    role: WorkerRole
    startup_command?: string | null
  }
): Promise<CreateWorkerResult> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/workers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to create worker'))
  }

  const payload = (await response.json()) as CreateWorkerPayload
  return {
    agentStart: {
      error: payload.agent_start?.error ?? null,
      ok: payload.agent_start?.ok ?? false,
      runId: payload.agent_start?.run_id ?? null,
    },
    worker: fromPayload(payload),
  }
}

export const deleteWorker = async (workspaceId: string, workerId: string): Promise<void> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/workers/${workerId}`, {
    method: 'DELETE',
  })

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to delete worker'))
  }
}

export const renameWorker = async (
  workspaceId: string,
  workerId: string,
  name: string
): Promise<void> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/workers/${workerId}`, {
    body: JSON.stringify({ name }),
    headers: { 'content-type': 'application/json' },
    method: 'PATCH',
  })

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to rename worker'))
  }
}

export const updateWorkerAvatar = async (
  workspaceId: string,
  workerId: string,
  avatar: string | null
): Promise<TeamListItem> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/workers/${workerId}`, {
    body: JSON.stringify({ avatar }),
    headers: { 'content-type': 'application/json' },
    method: 'PATCH',
  })

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to update worker avatar'))
  }

  return fromPayload((await response.json()) as TeamListItemPayload)
}

export const getWorkspaceTasks = async (workspaceId: string): Promise<{ content: string }> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/tasks`)

  if (!response.ok) {
    throw new Error('Failed to load tasks')
  }

  return (await response.json()) as { content: string }
}

export const saveWorkspaceTasks = async (
  workspaceId: string,
  input: { content: string }
): Promise<{ content: string }> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/tasks`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })

  if (!response.ok) {
    throw new Error('Failed to save tasks')
  }

  return (await response.json()) as { content: string }
}

export interface FsBrowseEntryPayload {
  is_dir: true
  is_git_repository: boolean
  name: string
  path: string
}

export interface FsBrowseResponse {
  current_path: string
  documents?: WorkspaceDocumentSummary[]
  entries: FsBrowseEntryPayload[]
  error: string | null
  ok: boolean
  parent_path: string | null
  root_path: string
}

export interface FsProbeResponse {
  current_branch: string | null
  documents?: WorkspaceDocumentSummary[]
  exists: boolean
  is_dir: boolean
  is_git_repository: boolean
  ok: boolean
  path: string
  suggested_name: string
}

export const browseFs = async (path: string): Promise<FsBrowseResponse> => {
  const query = path ? `?path=${encodeURIComponent(path)}` : ''
  const response = await apiFetch(`/api/fs/browse${query}`, { mode: 'same-origin' })
  const body = (await response.json()) as FsBrowseResponse
  return body
}

export const probeFs = async (path: string): Promise<FsProbeResponse> => {
  const response = await apiFetch(`/api/fs/probe?path=${encodeURIComponent(path)}`, {
    mode: 'same-origin',
  })
  return (await response.json()) as FsProbeResponse
}

export interface PickFolderResponse {
  canceled: boolean
  error: string | null
  path: string | null
  probe: FsProbeResponse | null
  supported: boolean
}

export const pickFolder = async (): Promise<PickFolderResponse> => {
  const response = await apiFetch('/api/fs/pick-folder', {
    method: 'POST',
    mode: 'same-origin',
  })
  return (await response.json()) as PickFolderResponse
}

export type OpenWorkspaceResult =
  | { ok: true; effectiveTargetId: OpenTargetId }
  | { ok: false; effectiveTargetId: OpenTargetId; errorCode: OpenWorkspaceErrorCode }

interface OpenWorkspaceSuccessPayload {
  ok: true
  effective_target_id: OpenTargetId
}

interface OpenWorkspaceFailurePayload {
  ok: false
  effective_target_id: OpenTargetId
  error_code: OpenWorkspaceErrorCode
}

export const openWorkspaceInEditor = async (
  workspaceId: string,
  targetId: OpenTargetId
): Promise<OpenWorkspaceResult> => {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/open`, {
    body: JSON.stringify({ target_id: targetId }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })

  // 200 success and 502 service failure both return structured JSON we can
  // surface; only true transport / 4xx failures (workspace gone, target id
  // tampered) throw.
  if (response.status === 200) {
    const body = (await response.json()) as OpenWorkspaceSuccessPayload
    return { ok: true, effectiveTargetId: body.effective_target_id }
  }
  if (response.status === 502) {
    const body = (await response.json()) as OpenWorkspaceFailurePayload
    return {
      ok: false,
      effectiveTargetId: body.effective_target_id,
      errorCode: body.error_code,
    }
  }
  throw new Error(await readErrorMessage(response, 'Failed to open workspace'))
}
