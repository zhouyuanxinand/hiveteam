import type { Database } from 'better-sqlite3'

export type RemoteAuditResult = 'ok' | 'rejected' | 'error'
export type RemoteAuditAction =
  | 'http'
  | 'ws_input'
  | 'ws_open'
  | 'session_open'
  | 'session_close'
  | 'revoke'
  | 'reject'

export interface RemoteAuditEvent {
  deviceId?: string | null
  action: RemoteAuditAction
  endpoint?: string | null
  workspaceId?: string | null
  result: RemoteAuditResult
  rejectReason?: string | null
  byteCount?: number | null
  preview?: string | null
}

export interface RemoteAuditRecord {
  id: number
  deviceId: string | null
  ts: number
  workspaceId: string | null
  action: string
  endpoint: string | null
  result: string
  rejectReason: string | null
  byteCount: number | null
  preview: string | null
}

export const AUDIT_PREVIEW_MAX = 120

const normalizePreview = (preview: string | null | undefined) =>
  preview === null || preview === undefined ? null : preview.slice(0, AUDIT_PREVIEW_MAX)

export const createRemoteAuditStore = (db: Database) => {
  const pending: Array<{ event: RemoteAuditEvent; ts: number }> = []
  let drain: Promise<void> | null = null
  const auditColumns = new Set(
    (db.prepare('PRAGMA table_info(remote_audit)').all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  )
  const deviceColumn = auditColumns.has('device_id')
    ? 'device_id'
    : auditColumns.has('remote_device_id')
      ? 'remote_device_id'
      : null

  if (!deviceColumn) throw new Error('remote_audit table has no device identifier column')

  const insert = db.prepare(
    `INSERT INTO remote_audit (
       ${deviceColumn}, ts, workspace_id, action, endpoint, result, reject_reason, byte_count, preview
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const select = `SELECT id, ${deviceColumn} AS device_id, ts, workspace_id, action,
    endpoint, result, reject_reason, byte_count, preview
    FROM remote_audit`

  const drainPending = async () => {
    if (drain) return drain
    drain = Promise.resolve()
      .then(() => {
        const batch = pending.splice(0, pending.length)
        if (batch.length === 0) return
        const transaction = db.transaction(() => {
          for (const item of batch) {
            insert.run(
              item.event.deviceId ?? null,
              item.ts,
              item.event.workspaceId ?? null,
              item.event.action,
              item.event.endpoint ?? null,
              item.event.result,
              item.event.rejectReason ?? null,
              item.event.byteCount ?? null,
              normalizePreview(item.event.preview)
            )
          }
        })
        transaction()
      })
      .finally(() => {
        drain = null
      })
    return drain
  }

  return {
    enqueue(event: RemoteAuditEvent, ts = Date.now()) {
      pending.push({ event, ts })
      void drainPending()
    },
    async flush() {
      while (pending.length > 0 || drain) await drainPending()
    },
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
