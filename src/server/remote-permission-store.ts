import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import {
  REMOTE_ACTIONS,
  REMOTE_GRANT_DURATION_MS,
  type RemoteAccess,
  type RemoteAccessRequest,
  type RemoteAction,
  type RemoteGrant,
} from '../shared/remote-permissions.js'
import { HttpError } from './http-errors.js'
import type { RemoteAuditStore } from './remote-audit-store.js'
import type { Database } from './sqlite.js'

export class RemotePermissionError extends HttpError {
  constructor(
    readonly code: string,
    message: string,
    status = 403
  ) {
    super(status, message)
    this.name = 'RemotePermissionError'
  }
}

type RequestRow = Omit<RemoteAccessRequest, 'actions'> & {
  actions_json: string
  runtime_instance_id: string
}
type GrantRow = Omit<RemoteGrant, 'actions' | 'remaining_ms'> & {
  actions_json: string
  runtime_instance_id: string
  expiry_audited: number
}

export const parseRemoteActions = (input: unknown): RemoteAction[] => {
  if (
    !Array.isArray(input) ||
    input.length === 0 ||
    input.some((action) => !REMOTE_ACTIONS.includes(action))
  ) {
    throw new RemotePermissionError(
      'remote_invalid_actions',
      'Select at least one known remote action',
      400
    )
  }
  return [...new Set(input)] as RemoteAction[]
}

export const createRemotePermissionStore = (
  db: Database,
  audit: RemoteAuditStore,
  clock: { now?: () => number; monotonic?: () => number } = {}
) => {
  const now = clock.now ?? Date.now
  const monotonic = clock.monotonic ?? (() => performance.now())
  const instanceId = randomUUID()
  const grantDeadlines = new Map<string, number>()
  const requestDeadlines = new Map<string, number>()
  const listeners = new Set<(deviceId: string) => void>()
  let auditFailed = false
  let closed = false
  const changed = (deviceId: string) => {
    for (const listener of listeners) listener(deviceId)
  }
  const fail = (code: string, message: string): never => {
    throw new RemotePermissionError(code, message)
  }
  const assertDevice = (deviceId: string) => {
    if (closed)
      throw new RemotePermissionError('remote_runtime_closed', 'Remote access is closed', 503)
    if (
      !db.prepare('SELECT id FROM remote_devices WHERE id = ? AND revoked_at IS NULL').get(deviceId)
    ) {
      fail('remote_device_revoked', 'Remote device is missing or revoked')
    }
  }
  const scopes = (deviceId: string) =>
    (
      db
        .prepare(
          'SELECT workspace_id FROM remote_read_scopes WHERE device_id = ? ORDER BY workspace_id'
        )
        .all(deviceId) as Array<{ workspace_id: string }>
    ).map((row) => row.workspace_id)
  const assertRead = (deviceId: string, workspaceId: string) => {
    assertDevice(deviceId)
    if (
      !db
        .prepare('SELECT 1 FROM remote_read_scopes WHERE device_id = ? AND workspace_id = ?')
        .get(deviceId, workspaceId)
    ) {
      fail('remote_workspace_forbidden', 'This device is not approved to view this workspace')
    }
  }
  const requestSelect = `SELECT r.*, d.name AS device_name, w.name AS workspace_name FROM remote_access_requests r JOIN remote_devices d ON d.id = r.device_id JOIN workspaces w ON w.id = r.workspace_id`
  const requestDto = (row: RequestRow): RemoteAccessRequest => {
    const { actions_json, runtime_instance_id, ...result } = row
    const deadline = requestDeadlines.get(row.id)
    if (
      row.status === 'pending' &&
      (runtime_instance_id !== instanceId ||
        deadline === undefined ||
        monotonic() >= deadline ||
        now() >= row.expires_at)
    ) {
      result.status = 'expired'
      result.resolved_at = now()
      db.transaction(() => {
        audit.append({
          action: 'grant_reject',
          deviceId: row.device_id,
          workspaceId: row.workspace_id,
          resourceId: row.id,
          result: 'rejected',
          decision: 'expired',
        })
        db.prepare(
          "UPDATE remote_access_requests SET status = 'expired', resolved_at = ? WHERE id = ? AND status = 'pending'"
        ).run(now(), row.id)
      })()
    }
    return { ...result, actions: JSON.parse(actions_json) as RemoteAction[] }
  }
  const findRequest = (id: string) => {
    const row = db.prepare(`${requestSelect} WHERE r.id = ?`).get(id) as RequestRow | undefined
    if (!row)
      throw new RemotePermissionError(
        'remote_request_missing',
        'Remote access request not found',
        404
      )
    return requestDto(row)
  }
  const listRequests = (deviceId?: string): RemoteAccessRequest[] => {
    const rows = deviceId
      ? db
          .prepare(`${requestSelect} WHERE r.device_id = ? ORDER BY r.requested_at DESC LIMIT 100`)
          .all(deviceId)
      : db.prepare(`${requestSelect} ORDER BY r.requested_at DESC LIMIT 100`).all()
    return (rows as RequestRow[]).map(requestDto)
  }
  const grantDto = (row: GrantRow): RemoteGrant => {
    const { actions_json, runtime_instance_id, expiry_audited, ...result } = row
    const deadline = grantDeadlines.get(row.id)
    const remaining =
      row.revoked_at === null &&
      !expiry_audited &&
      runtime_instance_id === instanceId &&
      deadline !== undefined
        ? Math.max(0, Math.min(row.expires_at - now(), deadline - monotonic()))
        : 0
    if (remaining === 0 && row.revoked_at === null && !expiry_audited) {
      db.transaction(() => {
        audit.append({
          action: 'grant_expire',
          deviceId: row.device_id,
          workspaceId: row.workspace_id,
          grantId: row.id,
          result: 'ok',
          decision: 'expired',
        })
        db.prepare('UPDATE remote_write_grants SET expiry_audited = 1 WHERE id = ?').run(row.id)
      })()
    }
    return {
      ...result,
      actions: JSON.parse(actions_json) as RemoteAction[],
      remaining_ms: Math.floor(remaining),
    }
  }
  const getGrant = (id: string) => {
    const row = db.prepare('SELECT * FROM remote_write_grants WHERE id = ?').get(id) as
      | GrantRow
      | undefined
    if (!row) throw new RemotePermissionError('remote_grant_missing', 'Remote grant not found', 404)
    return grantDto(row)
  }
  const getAccess = (deviceId: string): RemoteAccess => {
    assertDevice(deviceId)
    const workspaceIds = scopes(deviceId)
    const grants = (
      db
        .prepare('SELECT * FROM remote_write_grants WHERE device_id = ? AND revoked_at IS NULL')
        .all(deviceId) as GrantRow[]
    )
      .map(grantDto)
      .filter(
        (grant) =>
          !auditFailed && grant.remaining_ms > 0 && workspaceIds.includes(grant.workspace_id)
      )
    return {
      device_id: deviceId,
      workspace_ids: workspaceIds,
      grants,
      requests: listRequests(deviceId),
      server_time: now(),
      mode: grants.length ? 'limited_write' : 'read_only',
    }
  }
  const authorize = (deviceId: string, workspaceId: string, action?: RemoteAction) => {
    if (action && auditFailed)
      throw new RemotePermissionError(
        'remote_audit_unavailable',
        'Remote writes are disabled because execution audit failed; restart after repairing storage',
        503
      )
    assertRead(deviceId, workspaceId)
    if (!action) return null
    const grant = getAccess(deviceId).grants.find(
      (candidate) => candidate.workspace_id === workspaceId && candidate.actions.includes(action)
    )
    if (!grant)
      throw new RemotePermissionError(
        'remote_action_forbidden',
        `Desktop approval is required for ${action}`
      )
    return grant.id
  }
  return {
    authorize,
    inputEpoch(deviceId: string) {
      try {
        const access = getAccess(deviceId)
        return JSON.stringify([
          instanceId,
          access.workspace_ids,
          access.grants.map((grant) => grant.id).sort(),
        ])
      } catch (error) {
        if (error instanceof RemotePermissionError) return 'revoked'
        throw error
      }
    },
    assertRead,
    getAccess,
    listRequests,
    close() {
      closed = true
      listeners.clear()
    },
    blockAfterAuditFailure(error: unknown) {
      auditFailed = true
      console.error(
        '[HiveTeam] Remote execution audit failed; new remote writes are disabled.',
        error
      )
    },
    canRead(deviceId: string, workspaceId: string) {
      try {
        assertRead(deviceId, workspaceId)
        return true
      } catch (error) {
        if (error instanceof RemotePermissionError) return false
        throw error
      }
    },
    setReadScopes(deviceId: string, workspaceIds: unknown) {
      assertDevice(deviceId)
      if (
        !Array.isArray(workspaceIds) ||
        workspaceIds.some(
          (id) =>
            typeof id !== 'string' || !db.prepare('SELECT id FROM workspaces WHERE id = ?').get(id)
        )
      ) {
        throw new RemotePermissionError('remote_invalid_scopes', 'Select existing workspaces', 400)
      }
      const selected = [...new Set(workspaceIds)] as string[]
      db.transaction(() => {
        audit.append({ action: 'scope_change', deviceId, result: 'ok', decision: 'local_user' })
        db.prepare('DELETE FROM remote_read_scopes WHERE device_id = ?').run(deviceId)
        for (const id of selected)
          db.prepare('INSERT INTO remote_read_scopes(device_id, workspace_id) VALUES (?, ?)').run(
            deviceId,
            id
          )
        db.prepare(
          'UPDATE remote_write_grants SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL AND workspace_id NOT IN (SELECT workspace_id FROM remote_read_scopes WHERE device_id = ?)'
        ).run(now(), deviceId, deviceId)
      })()
      changed(deviceId)
      return getAccess(deviceId)
    },
    request(
      deviceId: string,
      input: { workspaceId: string; actions: unknown; durationMs?: unknown }
    ) {
      assertRead(deviceId, input.workspaceId)
      const actions = parseRemoteActions(input.actions)
      const duration = input.durationMs ?? REMOTE_GRANT_DURATION_MS
      if (
        typeof duration !== 'number' ||
        !Number.isSafeInteger(duration) ||
        duration < 1000 ||
        duration > REMOTE_GRANT_DURATION_MS
      ) {
        throw new RemotePermissionError(
          'remote_invalid_duration',
          'Access duration must be between 1 second and 10 minutes',
          400
        )
      }
      const pending = listRequests(deviceId).filter((row) => row.status === 'pending')
      const existing = pending.find(
        (row) =>
          row.workspace_id === input.workspaceId &&
          row.duration_ms === duration &&
          [...row.actions].sort().join() === [...actions].sort().join()
      )
      if (existing) return existing
      if (pending.length >= 20)
        throw new RemotePermissionError(
          'remote_request_limit',
          'Too many pending access requests',
          429
        )
      const id = randomUUID()
      const time = now()
      db.transaction(() => {
        audit.append({
          action: 'access_request',
          deviceId,
          workspaceId: input.workspaceId,
          resourceId: id,
          result: 'ok',
        })
        db.prepare(
          `INSERT INTO remote_access_requests(id, device_id, workspace_id, actions_json, duration_ms, requested_at, expires_at, runtime_instance_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
        ).run(
          id,
          deviceId,
          input.workspaceId,
          JSON.stringify(actions),
          duration,
          time,
          time + REMOTE_GRANT_DURATION_MS,
          instanceId
        )
      })()
      requestDeadlines.set(id, monotonic() + REMOTE_GRANT_DURATION_MS)
      changed(deviceId)
      return findRequest(id)
    },
    approve(requestId: string) {
      if (auditFailed)
        throw new RemotePermissionError(
          'remote_audit_unavailable',
          'Repair audit storage and restart before approving remote writes',
          503
        )
      const request = findRequest(requestId)
      assertRead(request.device_id, request.workspace_id)
      if (request.status === 'approved' && request.grant_id) return getGrant(request.grant_id)
      if (request.status !== 'pending')
        throw new RemotePermissionError(
          'remote_request_closed',
          'This access request is no longer pending',
          409
        )
      const id = randomUUID()
      const time = now()
      db.transaction(() => {
        audit.append({
          action: 'grant_approve',
          deviceId: request.device_id,
          workspaceId: request.workspace_id,
          grantId: id,
          resourceId: requestId,
          result: 'ok',
          decision: 'local_user',
        })
        db.prepare(
          'INSERT INTO remote_write_grants(id, request_id, device_id, workspace_id, actions_json, approved_by, runtime_instance_id, issued_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(
          id,
          requestId,
          request.device_id,
          request.workspace_id,
          JSON.stringify(request.actions),
          'local_user',
          instanceId,
          time,
          time + request.duration_ms
        )
        db.prepare(
          "UPDATE remote_access_requests SET status = 'approved', resolved_at = ?, grant_id = ? WHERE id = ?"
        ).run(time, id, requestId)
      })()
      grantDeadlines.set(id, monotonic() + request.duration_ms)
      changed(request.device_id)
      return getGrant(id)
    },
    reject(requestId: string) {
      const request = findRequest(requestId)
      if (request.status !== 'pending')
        throw new RemotePermissionError(
          'remote_request_closed',
          'This access request is no longer pending',
          409
        )
      db.transaction(() => {
        audit.append({
          action: 'grant_reject',
          deviceId: request.device_id,
          workspaceId: request.workspace_id,
          resourceId: requestId,
          result: 'rejected',
          decision: 'local_user',
        })
        db.prepare(
          "UPDATE remote_access_requests SET status = 'rejected', resolved_at = ? WHERE id = ?"
        ).run(now(), requestId)
      })()
      changed(request.device_id)
    },
    revokeGrant(grantId: string) {
      const grant = getGrant(grantId)
      db.transaction(() => {
        audit.append({
          action: 'grant_revoke',
          deviceId: grant.device_id,
          workspaceId: grant.workspace_id,
          grantId,
          result: 'ok',
          decision: 'local_user',
        })
        db.prepare(
          'UPDATE remote_write_grants SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?'
        ).run(now(), grantId)
      })()
      changed(grant.device_id)
    },
    subscribe(listener: (deviceId: string) => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

export type RemotePermissionStore = ReturnType<typeof createRemotePermissionStore>
