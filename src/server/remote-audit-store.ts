import type { Database } from './sqlite.js'

export type RemoteAuditResult = 'ok' | 'rejected' | 'error' | 'authorized'
export type RemoteAuditAction =
  | 'http'
  | 'http_transport'
  | 'http_input'
  | 'ws_input'
  | 'ws_control'
  | 'ws_open'
  | 'session_open'
  | 'session_close'
  | 'revoke'
  | 'reject'
  | 'access_request'
  | 'grant_approve'
  | 'grant_reject'
  | 'grant_expire'
  | 'grant_revoke'
  | 'scope_change'

export interface RemoteAuditEvent {
  deviceId?: string | null
  action: RemoteAuditAction
  endpoint?: string | null
  workspaceId?: string | null
  result: RemoteAuditResult
  rejectReason?: string | null
  byteCount?: number | null
  /** Retained for source compatibility; input content is never persisted. */
  preview?: string | null
  method?: string | null
  businessAction?: string | null
  resourceId?: string | null
  grantId?: string | null
  decision?: string | null
  statusCode?: number | null
}

export interface RemoteAuditRecord {
  id: number
  device_id: string | null
  ts: number
  workspace_id: string | null
  action: string
  endpoint: string | null
  result: string
  reject_reason: string | null
  byte_count: number | null
  preview: null
  method: string | null
  business_action: string | null
  resource_id: string | null
  grant_id: string | null
  decision: string | null
  status_code: number | null
}

export const createRemoteAuditStore = (
  db: Database,
  onBackgroundFailure: (error: unknown) => void = (error) =>
    console.error('[hive] remote transport audit failed', error)
) => {
  const columns = new Set(
    (db.prepare('PRAGMA table_info(remote_audit)').all() as Array<{ name: string }>).map(
      (c) => c.name
    )
  )
  const deviceColumn = columns.has('device_id')
    ? 'device_id'
    : columns.has('remote_device_id')
      ? 'remote_device_id'
      : null
  if (!deviceColumn) throw new Error('remote_audit table has no device identifier column')
  const extras = ['method', 'business_action', 'resource_id', 'grant_id', 'decision', 'status_code']
  for (const column of extras) {
    if (!columns.has(column))
      throw new Error(`remote_audit requires the current schema; missing ${column}`)
  }
  const extended = extras
  const names = [
    deviceColumn,
    'ts',
    'workspace_id',
    'action',
    'endpoint',
    'result',
    'reject_reason',
    'byte_count',
    'preview',
    ...extended,
  ]
  const insert = db.prepare(
    `INSERT INTO remote_audit (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`
  )
  const select = `SELECT id, ${deviceColumn} AS device_id, ts, workspace_id, action, endpoint, result, reject_reason, byte_count, NULL AS preview, ${extras.join(', ')} FROM remote_audit`
  const append = (event: RemoteAuditEvent, ts = Date.now()) => {
    const fields: Record<string, string | number | null> = {
      method: event.method ?? null,
      business_action: event.businessAction ?? null,
      resource_id: event.resourceId ?? null,
      grant_id: event.grantId ?? null,
      decision: event.decision ?? null,
      status_code: event.statusCode ?? null,
    }
    return Number(
      insert.run(
        event.deviceId ?? null,
        ts,
        event.workspaceId ?? null,
        event.action,
        event.endpoint?.split('?')[0] ?? null,
        event.result,
        event.rejectReason ?? null,
        event.byteCount ?? null,
        null,
        ...extended.map((column) => fields[column] ?? null)
      ).lastInsertRowid
    )
  }
  return {
    append,
    // Transport callbacks have no request error boundary. Their failure handler
    // disables further remote writes; privileged execution uses append directly.
    enqueue(event: RemoteAuditEvent, ts = Date.now()) {
      try {
        append(event, ts)
      } catch (error) {
        onBackgroundFailure(error)
      }
    },
    async flush() {},
    list(limit = 100) {
      return db
        .prepare(`${select} ORDER BY id DESC LIMIT ?`)
        .all(Math.max(1, Math.min(limit, 1000))) as RemoteAuditRecord[]
    },
    listForDevice(deviceId: string, limit = 100) {
      return db
        .prepare(`${select} WHERE ${deviceColumn} = ? ORDER BY id DESC LIMIT ?`)
        .all(deviceId, Math.max(1, Math.min(limit, 1000))) as RemoteAuditRecord[]
    },
  }
}

export type RemoteAuditStore = ReturnType<typeof createRemoteAuditStore>
