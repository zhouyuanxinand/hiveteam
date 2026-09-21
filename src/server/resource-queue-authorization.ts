import type { Database } from 'better-sqlite3'
import type { ResourceQueueEntry } from '../shared/resource-queue.js'
import {
  captureRemoteQueueGrant,
  type RemoteQueueGrant,
  withRemoteActionCheck,
} from './remote-action-context.js'
import type { RemoteAuditStore } from './remote-audit-store.js'
import { RemotePermissionError, type RemotePermissionStore } from './remote-permission-store.js'

/** Queued work retains the original grant IDs; a later approval cannot revive it. */
export const createResourceQueueAuthorization = (
  db: Database,
  permissions: RemotePermissionStore,
  audit: RemoteAuditStore
) => {
  const validate = (guard: RemoteQueueGrant) => {
    permissions.assertRead(guard.deviceId, guard.workspaceId)
    const grants = permissions.getAccess(guard.deviceId).grants
    if (
      !guard.grantIds.length ||
      guard.grantIds.some(
        (id) => !grants.some((grant) => grant.id === id && grant.workspace_id === guard.workspaceId)
      )
    )
      throw new RemotePermissionError(
        'remote_grant_expired',
        'The original remote approval expired or was revoked'
      )
  }
  return {
    validate,
    auditExecution(
      entry: ResourceQueueEntry,
      guard: RemoteQueueGrant,
      result: 'authorized' | 'ok' | 'error'
    ) {
      const event = {
        deviceId: guard.deviceId,
        workspaceId: guard.workspaceId,
        action: 'http' as const,
        endpoint: 'resource_queue',
        businessAction: entry.kind === 'verification' ? 'delivery_manage' : 'agent_start',
        resourceId: entry.id,
        grantId: guard.grantIds[0] ?? null,
        result,
        decision: result === 'authorized' ? 'allow' : 'executed',
      }
      if (result === 'authorized') {
        audit.append(event)
        return
      }
      try {
        audit.append(event)
      } catch (error) {
        permissions.blockAfterAuditFailure(error)
      }
    },
    captureDispatch(dispatchId: string) {
      const guard = captureRemoteQueueGrant()
      if (guard)
        db.prepare(
          'INSERT INTO resource_dispatch_guards(dispatch_id,remote_guard_json) VALUES(?,?)'
        ).run(dispatchId, JSON.stringify(guard))
    },
    deliverDispatch<T>(dispatchId: string, deliver: () => T): T {
      const row = db
        .prepare('SELECT remote_guard_json FROM resource_dispatch_guards WHERE dispatch_id=?')
        .get(dispatchId) as { remote_guard_json: string } | undefined
      if (!row) return deliver()
      const guard = JSON.parse(row.remote_guard_json) as RemoteQueueGrant
      validate(guard)
      return withRemoteActionCheck(
        () => validate(guard),
        deliver,
        (runId, byteCount, write) => {
          const event = {
            deviceId: guard.deviceId,
            workspaceId: guard.workspaceId,
            action: 'http_input' as const,
            endpoint: 'queued_dispatch',
            businessAction: 'task_dispatch',
            resourceId: runId,
            grantId: guard.grantIds[0] ?? null,
            byteCount,
          }
          try {
            validate(guard)
          } catch (error) {
            audit.append({
              ...event,
              result: 'rejected',
              decision: 'deny',
              rejectReason:
                error instanceof RemotePermissionError ? error.code : 'authorization_error',
            })
            throw error
          }
          if (!write) return
          audit.append({ ...event, result: 'authorized', decision: 'allow' })
          try {
            write()
          } catch (error) {
            audit.append({ ...event, result: 'error', decision: 'executed' })
            throw error
          }
          try {
            audit.append({ ...event, result: 'ok', decision: 'executed' })
          } catch (error) {
            permissions.blockAfterAuditFailure(error)
          }
        },
        guard
      )
    },
  }
}
