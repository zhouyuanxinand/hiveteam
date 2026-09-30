import type { IncomingMessage, ServerResponse } from 'node:http'
import type { RemoteAction } from '../shared/remote-permissions.js'
import type {
  InitialInputTarget,
  InputExecution,
  RemoteQueueGrant,
} from './remote-action-context.js'
import { RemotePermissionError } from './remote-permission-store.js'
import { getRequestPrincipal } from './request-principal.js'
import type { RuntimeStore } from './runtime-store.js'
import { getWorkspaceShellAgentId } from './workspace-shell-runtime.js'

const policies = new Map<string, readonly RemoteAction[] | 'read' | 'self'>()
const requestChecks = new WeakMap<IncomingMessage, () => void>()
const queueGrants = new WeakMap<IncomingMessage, RemoteQueueGrant>()
export const remoteQueueGrantForRequest = (request: IncomingMessage) => queueGrants.get(request)
const inputExecutors = new WeakMap<IncomingMessage, InputExecution>()
export const recheckRemoteRequest = (request: IncomingMessage) => requestChecks.get(request)?.()
export const executeRemoteHttpInput = (
  request: IncomingMessage,
  runId: string,
  byteCount: number,
  write: (() => void) | null,
  initialTarget?: InitialInputTarget
) => {
  if (getRequestPrincipal(request)?.kind !== 'remote_device') {
    write?.()
    return
  }
  const execute = inputExecutors.get(request)
  if (!execute)
    throw new RemotePermissionError(
      'remote_action_forbidden',
      'This request cannot deliver terminal input'
    )
  execute(runId, byteCount, write, initialTarget)
}
const register = (
  method: string,
  paths: string[],
  actions: readonly RemoteAction[] | 'read' | 'self'
) => {
  for (const path of paths) policies.set(`${method} ${path}`, actions)
}
const workspace = '/api/workspaces/:workspaceId'
const uiWorkspace = '/api/ui/workspaces/:workspaceId'
const dispatch = `${uiWorkspace}/dispatches/:dispatchId`
register(
  'GET',
  [
    '/api/version',
    '/api/version/latest',
    '/api/workspaces',
    '/api/ui/team',
    '/api/settings/command-presets',
    '/api/settings/role-templates',
    '/api/ui/team-scenarios',
    '/api/remote/access',
    '/api/remote/access-requests',
  ],
  'self'
)
register('POST', ['/api/remote/access-requests'], 'self')
register(
  'GET',
  [
    `${workspace}/tasks`,
    `${workspace}/recovery-settings`,
    `${workspace}/review/documents`,
    `${workspace}/review/document`,
    `${workspace}/review/submissions/:requestId`,
    `${uiWorkspace}/team`,
    `${uiWorkspace}/members/retired`,
    `${uiWorkspace}/members/:workerId`,
    `${uiWorkspace}/runs`,
    `${uiWorkspace}/activity`,
    `${uiWorkspace}/attention`,
    `${uiWorkspace}/collaboration-stats`,
    dispatch,
    `${uiWorkspace}/delivery`,
    `${uiWorkspace}/onboarding`,
    `${uiWorkspace}/agents/:agentId/conversation`,
    `${uiWorkspace}/dispatches`,
    `${uiWorkspace}/message-deliveries`,
    `${dispatch}/diff`,
    `${dispatch}/verifications`,
    `${dispatch}/verifications/:verificationId/log`,
    `${uiWorkspace}/verification-profiles`,
    `${dispatch}/reviews`,
    `${dispatch}/review-requests`,
    `${uiWorkspace}/review-requests/:requestId`,
    `${dispatch}/reviews/context`,
    `${dispatch}/integration`,
    `${dispatch}/integration-candidates`,
    `${dispatch}/integration-candidates/:candidateId`,
    `${dispatch}/pull-request`,
    `${uiWorkspace}/git/status`,
    `${uiWorkspace}/git/commits`,
    `${uiWorkspace}/workers/:workerId/branch-update`,
    `${uiWorkspace}/workflows`,
    `${uiWorkspace}/workflows/runs`,
    `${uiWorkspace}/workflows/runs/:runId`,
    `${uiWorkspace}/workflows/runs/:runId/attempts`,
    `${uiWorkspace}/memory`,
    `${uiWorkspace}/memory/settings`,
    `${uiWorkspace}/memory/contexts`,
    `${uiWorkspace}/memory/:memoryId/sources`,
    `${uiWorkspace}/recovery-index`,
    `${uiWorkspace}/memory/dream`,
    `${uiWorkspace}/memory/dream/history`,
    `${uiWorkspace}/memory/dream/:runId`,
    `${uiWorkspace}/memory/dream/:runId/reviews`,
    `${uiWorkspace}/skill-packs`,
    '/api/runtime/runs/:runId',
    '/api/runtime/runs/:runId/stop-impact',
  ],
  'read'
)
register('PUT', [`${workspace}/tasks`], ['task_write'])
register(
  'POST',
  [`${workspace}/user-input`, '/api/runtime/runs/:runId/model-picker'],
  ['terminal_input']
)
register(
  'POST',
  [`${workspace}/agents/:agentId/start`, `${workspace}/shell/start`],
  ['agent_start']
)
register('POST', ['/api/runtime/runs/:runId/stop'], ['agent_stop'])
register('DELETE', [`${workspace}/shell/:runId`], ['agent_stop'])
register(
  'POST',
  [`${workspace}/workers`, `${uiWorkspace}/team-scenarios/:scenarioId`],
  ['workspace_manage', 'agent_start']
)
register('POST', [`${workspace}/agents/:agentId/config`], ['workspace_manage'])
register(
  'PATCH',
  [`${workspace}/workers/:workerId`, `${workspace}/recovery-settings`],
  ['workspace_manage']
)
register('DELETE', [`${workspace}/workers/:workerId`], ['workspace_manage', 'agent_stop'])
register('POST', [`${uiWorkspace}/workflows/runs`], ['workflow_manage', 'agent_start'])
register('POST', [`${uiWorkspace}/workflows/runs/:runId/stop`], ['workflow_manage'])
register(
  'POST',
  [
    `${uiWorkspace}/memory`,
    `${uiWorkspace}/memory/dream`,
    `${uiWorkspace}/memory/dream/:runId/reviews`,
    `${uiWorkspace}/memory/dream/:runId/submit`,
    `${uiWorkspace}/memory/dream/:runId/rollback`,
    `${uiWorkspace}/memory/dream/:runId/discard`,
  ],
  ['memory_write']
)
register(
  'PATCH',
  [`${uiWorkspace}/memory/:memoryId`, `${uiWorkspace}/memory/dream/:runId`],
  ['memory_write']
)
register('PUT', [`${uiWorkspace}/memory/settings`], ['memory_write'])
register('PUT', [`${uiWorkspace}/memory/budget`], ['memory_write'])
register(
  'POST',
  ['scan', 'resolve', 'plans', 'plans/:planId/apply', 'receipts/:receiptId/undo'].map(
    (suffix) => `${uiWorkspace}/skill-packs/${suffix}`
  ),
  ['skill_manage']
)
register(
  'POST',
  [
    `${dispatch}/accept`,
    `${dispatch}/feedback`,
    `${dispatch}/verifications`,
    `${dispatch}/verifications/:verificationId/cancel`,
    `${dispatch}/verifications/:verificationId/accept`,
    `${dispatch}/integration`,
    `${workspace}/review/confirm`,
    `${workspace}/review/send`,
    `${workspace}/review/answer`,
  ],
  ['delivery_manage']
)
register('PUT', [`${workspace}/review/draft`], ['delivery_manage'])
register(
  'POST',
  [
    `${uiWorkspace}/git/initialize`,
    `${uiWorkspace}/git/snapshots`,
    `${uiWorkspace}/git/commits/:commitSha/revert`,
    `${uiWorkspace}/workers/:workerId/branch-update`,
  ],
  ['git_write']
)
register('PUT', [`${uiWorkspace}/git/settings`], ['git_write'])
register('POST', [`${dispatch}/pull-request`, `${dispatch}/pull-request/refresh`], ['git_publish'])
register(
  'POST',
  [`${dispatch}/feedback`, `${workspace}/review/send`, `${workspace}/review/answer`],
  ['delivery_manage', 'agent_start']
)
register(
  'POST',
  [
    `${uiWorkspace}/memory/dream`,
    `${uiWorkspace}/memory/dream/:runId/reviews`,
    `${uiWorkspace}/memory/dream/:runId/submit`,
  ],
  ['memory_write', 'agent_start']
)

register('POST', [`${uiWorkspace}/memory/dream/generate`], ['memory_write', 'agent_start'])

export const workspaceForRun = (store: RuntimeStore, runId: string) => {
  const run = store.getLiveRun(runId)
  const owner = store
    .listWorkspaces()
    .find(
      (item) =>
        run.agentId === getWorkspaceShellAgentId(item.id) ||
        store.getWorkspaceSnapshot(item.id).agents.some((agent) => agent.id === run.agentId)
    )
  if (!owner)
    throw new RemotePermissionError('remote_workspace_missing', 'Run has no active workspace', 404)
  return owner.id
}

/** Exact route templates form a closed capability registry. New routes stay desktop-only. */
export const authorizeRemoteHttp = (
  request: IncomingMessage,
  response: ServerResponse,
  store: RuntimeStore,
  match: { method: string; path: string; params: Record<string, string> }
) => {
  const principal = getRequestPrincipal(request)
  if (principal?.kind !== 'remote_device') return
  const policy = policies.get(`${match.method} ${match.path}`)
  const resourceId =
    match.params.runId ??
    match.params.agentId ??
    match.params.workerId ??
    match.params.dispatchId ??
    null
  const entry = {
    deviceId: principal.deviceId,
    action: 'http' as const,
    method: match.method,
    endpoint: match.path,
    resourceId,
  }
  if (!policy) {
    store.remote.audit.append({
      ...entry,
      result: 'rejected',
      decision: 'deny',
      statusCode: 403,
      rejectReason: 'remote_endpoint_forbidden',
    })
    throw new RemotePermissionError(
      'remote_endpoint_forbidden',
      'This endpoint is available only on the desktop'
    )
  }
  const workspaceId =
    match.params.workspaceId ??
    (match.path.startsWith('/api/runtime/runs/') && match.params.runId
      ? workspaceForRun(store, match.params.runId)
      : undefined)
  const actions = Array.isArray(policy) ? policy : []
  let grantId: string | null = null
  const grants: string[] = []
  try {
    if (policy !== 'self') {
      if (!workspaceId)
        throw new RemotePermissionError(
          'remote_workspace_required',
          'Remote actions require a workspace'
        )
      store.remote.permissions.assertRead(principal.deviceId, workspaceId)
      for (const action of actions) {
        grantId = store.remote.permissions.authorize(principal.deviceId, workspaceId, action)
        if (grantId) grants.push(grantId)
      }
    }
  } catch (error) {
    if (!(error instanceof RemotePermissionError)) throw error
    store.remote.audit.append({
      ...entry,
      workspaceId: workspaceId ?? null,
      result: 'rejected',
      decision: 'deny',
      statusCode: error.statusCode,
      rejectReason: error.code,
    })
    throw error
  }
  const audit = {
    ...entry,
    workspaceId: workspaceId ?? null,
    grantId,
    businessAction: actions.join(',') || 'read',
  }
  if (workspaceId)
    if (grants.length)
      queueGrants.set(request, {
        deviceId: principal.deviceId,
        workspaceId,
        grantIds: [...new Set(grants)],
      })
  if (workspaceId)
    requestChecks.set(request, () => {
      store.remote.permissions.assertRead(principal.deviceId, workspaceId)
      const active = store.remote.permissions.getAccess(principal.deviceId).grants
      if (grants.some((id) => !active.some((grant) => grant.id === id))) {
        throw new RemotePermissionError(
          'remote_grant_expired',
          'The grant for this request expired or was revoked before execution'
        )
      }
    })
  // Reserve the audit record before any handler, JSON body processing or external side effect.
  if (workspaceId && actions.length)
    inputExecutors.set(request, (runId, byteCount, write, initialTarget) => {
      const event = { ...audit, action: 'http_input' as const, resourceId: runId, byteCount }
      try {
        recheckRemoteRequest(request)
        if (initialTarget) {
          if (
            initialTarget.workspaceId !== workspaceId ||
            (match.params.agentId && match.params.agentId !== initialTarget.agentId)
          )
            throw new RemotePermissionError(
              'remote_workspace_forbidden',
              'The initial input target does not match this start request'
            )
          if (!actions.includes('agent_start'))
            throw new RemotePermissionError(
              'remote_action_forbidden',
              'Initial agent input requires an authorized start request'
            )
          store.getAgent(workspaceId, initialTarget.agentId)
        } else if (workspaceForRun(store, runId) !== workspaceId)
          throw new RemotePermissionError(
            'remote_workspace_forbidden',
            'The input target belongs to another workspace'
          )
      } catch (error) {
        if (!(error instanceof RemotePermissionError)) throw error
        store.remote.audit.append({
          ...event,
          result: 'rejected',
          decision: 'deny',
          rejectReason: error.code,
        })
        throw error
      }
      if (!write) return
      store.remote.audit.append({ ...event, result: 'authorized', decision: 'allow' })
      try {
        write()
      } catch (error) {
        store.remote.audit.append({ ...event, result: 'error', decision: 'executed' })
        throw error
      }
      try {
        store.remote.audit.append({ ...event, result: 'ok', decision: 'executed' })
      } catch (error) {
        store.remote.permissions.blockAfterAuditFailure(error)
      }
    })
  store.remote.audit.append({ ...audit, result: 'authorized', decision: 'allow' })
  response.once('finish', () => {
    try {
      store.remote.audit.append({
        ...audit,
        result:
          response.statusCode < 400 ? 'ok' : response.statusCode === 403 ? 'rejected' : 'error',
        statusCode: response.statusCode,
        decision: 'executed',
      })
    } catch (error) {
      store.remote.permissions.blockAfterAuditFailure(error)
    }
  })
}
