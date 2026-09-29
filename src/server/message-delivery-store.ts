import { randomUUID } from 'node:crypto'
import type { MessageDelivery } from '../shared/message-delivery.js'
import { ConflictError, HttpError } from './http-errors.js'
import type { ReportDeliveryCheckpoint } from './report-delivery-receipt.js'
import type { Database } from './sqlite.js'

export interface DeliveryRecord extends MessageDelivery {
  checkpoint: string | null
  write_started: number
}
export const publicDelivery = ({
  checkpoint: _checkpoint,
  write_started: _write,
  ...record
}: DeliveryRecord): MessageDelivery => record

// Select only the next writable message for each recipient before applying the
// batch limit. A blocked recipient must not crowd other workspaces out of a tick.
const unblockedRecipient = `NOT EXISTS (
  SELECT 1 FROM message_deliveries AS blocker
  WHERE blocker.workspace_id = candidate.workspace_id
    AND blocker.recipient_id = candidate.recipient_id
    AND blocker.id <> candidate.id
    AND (blocker.state IN ('attempting','unknown','manual')
      OR (blocker.state = 'pending' AND blocker.rowid < candidate.rowid))
)`

export const createMessageDeliveryStore = (db: Database, now = Date.now) => {
  const atomic = <Args extends unknown[], Result>(
    operation: (...args: Args) => Result
  ): ((...args: Args) => Result) => {
    const transaction = db.transaction(operation)
    return (...args) => transaction.immediate(...args)
  }
  const get = (id: string) =>
    db.prepare('SELECT * FROM message_deliveries WHERE id=?').get(id) as DeliveryRecord | undefined
  const event = (
    id: string,
    name: string,
    actor: string,
    reason: string,
    detail: unknown = null
  ) => {
    const row = get(id)
    if (!row) throw new HttpError(404, 'Delivery not found')
    db.prepare('INSERT INTO message_delivery_events VALUES (?,?,?,?,?,?,?,?)').run(
      randomUUID(),
      id,
      row.attempt,
      now(),
      name,
      actor,
      reason,
      JSON.stringify(detail)
    )
  }
  const setState = (
    id: string,
    state: MessageDelivery['state'],
    evidence: MessageDelivery['evidence'],
    reason: string | null,
    next: number | null = null
  ) => {
    db.prepare(
      'UPDATE message_deliveries SET state=?,evidence=?,reason=?,next_attempt_at=? WHERE id=?'
    ).run(state, evidence, reason, next, id)
  }
  const requireAttempt = (id: string, attempt: number) => {
    const row = get(id)
    if (!row || row.state !== 'attempting' || row.attempt !== attempt)
      throw new ConflictError('Delivery attempt was stopped or superseded')
    return row
  }
  return {
    get,
    event,
    list(workspaceId: string, recipientId?: string) {
      return db
        .prepare(
          `SELECT * FROM message_deliveries WHERE workspace_id=? ${recipientId ? 'AND recipient_id=?' : ''} ORDER BY created_at,id`
        )
        .all(...(recipientId ? [workspaceId, recipientId] : [workspaceId])) as DeliveryRecord[]
    },
    due() {
      return db
        .prepare(
          `SELECT candidate.* FROM message_deliveries AS candidate
           WHERE candidate.state IN ('pending','unknown')
             AND (candidate.next_attempt_at IS NULL OR candidate.next_attempt_at<=?)
             AND (candidate.state='unknown' OR ${unblockedRecipient})
           ORDER BY COALESCE(candidate.next_attempt_at,0),candidate.created_at,candidate.rowid
           LIMIT 200`
        )
        .all(now()) as DeliveryRecord[]
    },
    recover: atomic(() => {
      for (const row of db
        .prepare("SELECT * FROM message_deliveries WHERE state='attempting'")
        .all() as DeliveryRecord[]) {
        setState(
          row.id,
          row.write_started ? 'unknown' : 'pending',
          row.evidence,
          'Runtime interrupted the previous attempt',
          row.write_started ? null : now()
        )
        event(row.id, 'interrupted', 'runtime', 'Preserved write checkpoint; no lease-based resend')
      }
    }),
    claim: atomic((id: string, runId: string, startingRecipient = false) => {
      const row = get(id)
      if (
        !row ||
        row.state !== 'pending' ||
        (!startingRecipient && row.next_attempt_at !== null && row.next_attempt_at > now())
      )
        return undefined
      // An uncertain composer blocks this recipient, not other recipients/workspaces.
      const available = db
        .prepare(
          `SELECT 1 FROM message_deliveries AS candidate
           WHERE candidate.id=? AND ${unblockedRecipient}`
        )
        .get(id)
      if (!available) return undefined
      db.prepare(
        "UPDATE message_deliveries SET state='attempting',attempt=attempt+1,run_id=?,reason=NULL,next_attempt_at=NULL WHERE id=?"
      ).run(runId, id)
      event(id, 'attempt_started', 'runtime', 'Recipient claimed before terminal input')
      return get(id)
    }),
    prepared: atomic((id: string, attempt: number, payload: string) => {
      requireAttempt(id, attempt)
      db.prepare(`INSERT INTO delivery_payload_measurements
        (delivery_id,attempt,utf8_bytes,prepared_at) VALUES(?,?,?,?)
        ON CONFLICT(delivery_id,attempt) DO NOTHING`).run(
        id,
        attempt,
        Buffer.byteLength(payload, 'utf8'),
        now()
      )
    }),
    beforeWrite: atomic((id: string, attempt: number) => {
      requireAttempt(id, attempt)
      db.prepare('UPDATE message_deliveries SET write_started=1 WHERE id=?').run(id)
      event(id, 'write_started', 'runtime', 'Persisted before PTY input')
    }),
    awaitingReceipt: atomic((id: string, attempt: number) => {
      const current = get(id)
      if (current?.attempt === attempt && ['confirmed', 'resolved'].includes(current.state)) return
      requireAttempt(id, attempt)
      setState(id, 'unknown', 'none', 'Waiting for Codex to journal its initial dispatch', now())
      event(
        id,
        'initial_prompt_launched',
        'runtime',
        'Awaiting native receipt without terminal input'
      )
    }),
    saveCheckpoint: atomic((id: string, attempt: number, checkpoint: ReportDeliveryCheckpoint) => {
      requireAttempt(id, attempt)
      db.prepare(
        'UPDATE message_deliveries SET checkpoint=?,session_id=?,write_started=1 WHERE id=?'
      ).run(JSON.stringify(checkpoint), checkpoint.sessionId, id)
      event(id, 'checkpoint', 'runtime', 'Persisted before native input', checkpoint)
    }),
    submitted: atomic((id: string, attempt: number, native: boolean) => {
      requireAttempt(id, attempt)
      db.prepare(
        'UPDATE message_deliveries SET submitted_at=COALESCE(submitted_at,?),confirmed_at=? WHERE id=?'
      ).run(now(), native ? now() : null, id)
      setState(
        id,
        native ? 'confirmed' : 'unknown',
        native ? 'native_receipt' : 'pty_write',
        native
          ? null
          : 'PTY accepted input; model receipt is not supported. Review before further automatic input.'
      )
      event(
        id,
        native ? 'confirmed' : 'submitted',
        'runtime',
        native ? 'Native user-message receipt' : 'Submission is not model acceptance'
      )
    }),
    confirm: atomic(
      (
        id: string,
        source: 'native_receipt' | 'worker_ack',
        checkpoint?: ReportDeliveryCheckpoint
      ) => {
        const row = get(id)
        if (!row || row.state === 'confirmed' || row.state === 'resolved') return
        if (checkpoint)
          db.prepare('UPDATE message_deliveries SET checkpoint=?,session_id=? WHERE id=?').run(
            JSON.stringify(checkpoint),
            checkpoint.sessionId,
            id
          )
        db.prepare('UPDATE message_deliveries SET confirmed_at=? WHERE id=?').run(now(), id)
        setState(id, 'confirmed', source, null)
        event(id, 'confirmed', source, 'Receipt reconciled without terminal input')
      }
    ),
    failed: atomic(
      (id: string, attempt: number, error: string, terminal: boolean | 'manual' = false) => {
        const row = get(id)
        if (!row || row.state !== 'attempting' || row.attempt !== attempt) return
        const state = row.write_started
          ? 'unknown'
          : terminal === 'manual'
            ? 'manual'
            : terminal
              ? 'resolved'
              : row.attempt >= 5
                ? 'manual'
                : 'pending'
        setState(
          id,
          state,
          row.evidence,
          error.slice(0, 2000),
          state === 'pending' ? now() + Math.min(30_000, 1000 * 2 ** (row.attempt - 1)) : null
        )
        event(id, 'attempt_failed', 'runtime', error.slice(0, 2000), {
          write_started: !!row.write_started,
        })
      }
    ),
    defer(id: string, reason: string) {
      db.prepare(
        "UPDATE message_deliveries SET next_attempt_at=?,reason=? WHERE id=? AND state IN ('pending','unknown')"
      ).run(now() + 1000, reason, id)
    },
    resolve: atomic((id: string, actor: string, reason: string, resend: boolean) => {
      const row = get(id)
      if (!row) throw new HttpError(404, 'Delivery not found')
      if (row.state === 'attempting')
        throw new ConflictError('Wait for the active attempt to finish')
      if (row.state === 'confirmed' || row.state === 'resolved')
        throw new ConflictError('Delivery is already handled')
      event(id, resend ? 'explicit_resend' : 'manual_resolution', actor, reason, {
        checkpoint: row.checkpoint,
        run_id: row.run_id,
        evidence: row.evidence,
      })
      setState(
        id,
        resend ? 'pending' : 'resolved',
        resend ? 'none' : 'manual',
        reason,
        resend ? now() : null
      )
      if (resend)
        db.prepare(
          'UPDATE message_deliveries SET checkpoint=NULL,write_started=0,session_id=NULL,run_id=NULL WHERE id=?'
        ).run(id)
    }),
    requestCancellation: atomic(
      (workspaceId: string, dispatchId: string, recipientId: string, reason: string) => {
        const id = randomUUID()
        const original = get(dispatchId)
        if (original?.state === 'pending')
          setState(original.id, 'resolved', original.evidence, 'Cancelled before delivery')
        db.prepare(
          "INSERT INTO message_deliveries(id,workspace_id,dispatch_id,recipient_id,kind,state,created_at,next_attempt_at,reason) VALUES(?,?,?,?,'cancel','pending',?,?,?)"
        ).run(id, workspaceId, dispatchId, recipientId, now(), now(), reason)
        event(id, 'cancel_requested', 'runtime', reason)
        return id
      }
    ),
    events(id: string) {
      return db
        .prepare(
          'SELECT id,attempt,created_at,event,actor,reason FROM message_delivery_events WHERE delivery_id=? ORDER BY created_at,rowid'
        )
        .all(id)
    },
  }
}
export type MessageDeliveryStore = ReturnType<typeof createMessageDeliveryStore>
