import type { Database } from 'better-sqlite3'
import type { AgentRuntime } from './agent-runtime.js'
import { buildWorkerCancelPayload } from './agent-stdin-dispatcher.js'
import { assertReportSession, createReportJournalReader } from './codex-report-journal.js'
import { createDispatchHealthStore } from './dispatch-health-store.js'
import type { createDispatchLedgerStore, DispatchRecord } from './dispatch-ledger-store.js'
import type { DispatchSkillActivationStore } from './dispatch-skill-activation-store.js'
import { ConflictError, HttpError } from './http-errors.js'
import {
  createMessageDeliveryStore,
  type DeliveryRecord,
  publicDelivery,
} from './message-delivery-store.js'
import { NativeSessionError } from './native-session-error.js'
import { withAdditionalActionCheck, withoutRemoteActionContext } from './remote-action-context.js'
import { RemotePermissionError } from './remote-permission-store.js'
import {
  type ReportDeliveryCheckpoint,
  reportReceiptMarker,
  type SystemMessageDeliveryOptions,
} from './report-delivery-receipt.js'
import type { ReportOutboxStore } from './report-outbox-store.js'
import type { WorkspaceStore } from './workspace-store.js'

export const createTeamDeliveryRuntime = (input: {
  db: Database
  agentRuntime: AgentRuntime
  workspaceStore: WorkspaceStore
  ledger: ReturnType<typeof createDispatchLedgerStore>
  outbox: ReportOutboxStore
  activations: DispatchSkillActivationStore
  authorize: <T>(dispatchId: string, action: () => T) => T
  onSubmitted: (dispatch: DispatchRecord) => void
}) => {
  const records = createMessageDeliveryStore(input.db)
  const health = createDispatchHealthStore(input.db)
  const active = new Map<string, { abort: AbortController; done: Promise<boolean> }>()
  const readers = new Map<
    string,
    { checkpoint: string; read: ReturnType<typeof createReportJournalReader> }
  >()
  let closing = false
  let timer: ReturnType<typeof setTimeout> | undefined
  records.recover()
  const requireDispatch = (workspaceId: string, id: string) => {
    const dispatch = input.ledger.getDispatchById(workspaceId, id)
    if (!dispatch) throw new HttpError(404, 'Dispatch not found')
    return dispatch
  }
  const persistAccepted = (record: DeliveryRecord, native: boolean) => {
    const dispatch = requireDispatch(record.workspace_id, record.dispatch_id)
    input.db.transaction(() => {
      if (record.kind === 'report') {
        const entry = input.outbox
          .listPending(record.workspace_id, record.recipient_id)
          .find((entry) => entry.receiptId === record.id)
        if (entry) input.outbox.markDelivered(entry.id)
      } else if (
        record.kind === 'dispatch' &&
        (dispatch.status === 'queued' || dispatch.status === 'failed')
      ) {
        input.ledger.markSubmitted(dispatch.id)
      }
      if (record.kind === 'dispatch')
        health.start(dispatch.id, native ? 'native_receipt' : 'submission_estimate')
    })()
    return dispatch
  }
  const notifyAccepted = (record: DeliveryRecord, dispatch: DispatchRecord) => {
    if (
      record.kind === 'dispatch' &&
      dispatch.status !== 'reported' &&
      dispatch.status !== 'cancelled'
    ) {
      input.workspaceStore.markTaskSubmitted(record.workspace_id, record.recipient_id)
      input.onSubmitted(dispatch)
    }
  }
  const recheck = (id: string) => {
    const record = records.get(id)
    if (!record) throw new HttpError(404, 'Delivery not found')
    if (record.state === 'confirmed') return record.evidence === 'native_receipt'
    if (record.state === 'resolved') return false
    if (record.state === 'attempting') return false
    if (!record.checkpoint) return false
    const checkpoint = JSON.parse(record.checkpoint) as ReportDeliveryCheckpoint
    assertReportSession(checkpoint.sessionFile, checkpoint.sessionId, checkpoint.cwd)
    let reader = readers.get(id)
    if (!reader || reader.checkpoint !== record.checkpoint) {
      reader = {
        checkpoint: record.checkpoint,
        read: createReportJournalReader(
          checkpoint.sessionFile,
          checkpoint.offset,
          reportReceiptMarker(record.id)
        ),
      }
      readers.set(id, reader)
    }
    for (let i = 0; i < 32; i++) {
      const result = reader.read()
      if (result.found) {
        const dispatch = input.db.transaction(() => {
          records.confirm(id, 'native_receipt')
          return persistAccepted(record, true)
        })()
        notifyAccepted(record, dispatch)
        readers.delete(id)
        return true
      }
      if (result.caughtUp) break
    }
    return false
  }
  const deliver = (id: string): Promise<boolean> => {
    if (closing) return Promise.resolve(false)
    const existing = active.get(id)
    if (existing) return existing.done
    const record = records.get(id)
    if (!record || record.state !== 'pending') return Promise.resolve(false)
    const run = input.agentRuntime.getActiveRunByAgentId(record.workspace_id, record.recipient_id)
    if (
      !run ||
      input.workspaceStore.isAgentManuallyStopped(record.workspace_id, record.recipient_id)
    ) {
      records.defer(id, 'Recipient is stopped; start it explicitly to deliver')
      return Promise.resolve(false)
    }
    const claimed = records.claim(id, run.runId)
    if (!claimed) return Promise.resolve(false)
    const abort = new AbortController()
    const done = Promise.resolve()
      .then(() => {
        const send = () =>
          withAdditionalActionCheck(
            () => {
              if (closing || abort.signal.aborted) throw new ConflictError('Delivery was cancelled')
              const current = requireDispatch(record.workspace_id, record.dispatch_id)
              if (
                record.kind === 'dispatch' &&
                (current.status === 'cancelled' || current.status === 'reported')
              )
                throw new ConflictError('Dispatch is closed')
            },
            async () => {
              let native = false
              const options: SystemMessageDeliveryOptions = {
                requireActiveRun: true,
                receipt: {
                  id,
                  checkpoint: claimed.checkpoint ? JSON.parse(claimed.checkpoint) : null,
                  save: (checkpoint) => {
                    input.db.transaction(() => {
                      records.saveCheckpoint(id, claimed.attempt, checkpoint)
                      if (record.kind === 'report') {
                        const entry = input.outbox
                          .listPending(record.workspace_id, record.recipient_id)
                          .find((entry) => entry.receiptId === id)
                        if (!entry) throw new ConflictError('Report was removed')
                        input.outbox.saveCheckpoint(entry.id, id, checkpoint)
                      }
                    })()
                  },
                },
                delivery: {
                  signal: abort.signal,
                  timeoutMs: health.get(record.dispatch_id)?.timeouts.delivery_ms ?? 15_000,
                  beforeWrite: () => records.beforeWrite(id, claimed.attempt),
                  nativeReceipt: () => {
                    native = true
                  },
                },
              }
              const dispatch = requireDispatch(record.workspace_id, record.dispatch_id)
              if (record.kind === 'dispatch') {
                const worker = input.workspaceStore.getWorker(
                  record.workspace_id,
                  record.recipient_id
                )
                const sender = dispatch.fromAgentId
                  ? input.workspaceStore.getAgent(record.workspace_id, dispatch.fromAgentId).name
                  : 'Hive'
                await input.agentRuntime.writeSendPrompt(
                  record.workspace_id,
                  record.recipient_id,
                  dispatch.id,
                  sender,
                  worker.description,
                  dispatch.text,
                  input.workspaceStore.getWorkspaceSnapshot(record.workspace_id).summary.language ??
                    'zh',
                  input.activations.get(dispatch.id) ?? undefined,
                  options
                )
              } else {
                const entry =
                  record.kind === 'report'
                    ? input.outbox
                        .listPending(record.workspace_id, record.recipient_id)
                        .find((entry) => entry.receiptId === id)
                    : undefined
                if (record.kind === 'report' && !entry)
                  throw new ConflictError('Report was removed')
                if (entry) input.outbox.markDeliveryAttempt(entry.id)
                await input.agentRuntime.deliverSystemMessageToAgent(
                  record.workspace_id,
                  record.recipient_id,
                  entry?.payload ??
                    buildWorkerCancelPayload(dispatch.id, dispatch.reportText ?? 'Cancelled'),
                  options
                )
              }
              const accepted = input.db.transaction(() => {
                records.submitted(id, claimed.attempt, native)
                return persistAccepted(claimed, native)
              })()
              notifyAccepted(claimed, accepted)
              return true
            }
          )
        return record.kind === 'dispatch' ? input.authorize(record.dispatch_id, send) : send()
      })
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error)
        records.failed(
          id,
          claimed.attempt,
          reason,
          error instanceof NativeSessionError ? 'manual' : error instanceof RemotePermissionError
        )
        if (record.kind === 'report') {
          const entry = input.outbox
            .listPending(record.workspace_id, record.recipient_id)
            .find((entry) => entry.receiptId === id)
          if (entry) input.outbox.markDeliveryFailed(entry.id, reason)
        } else if (
          record.kind === 'dispatch' &&
          input.ledger.findOpenDispatchById(record.workspace_id, record.dispatch_id)
        )
          input.ledger.markDeliveryFailed(record.dispatch_id, reason)
        return false
      })
      .finally(() => {
        active.delete(id)
        wake()
      })
    active.set(id, { abort, done })
    return done
  }
  const tick = () => {
    timer = undefined
    if (closing) return
    try {
      health.tick()
      for (const record of records.due()) {
        if (record.state === 'unknown') {
          try {
            recheck(record.id)
          } catch (error) {
            readers.delete(record.id)
            records.defer(record.id, error instanceof Error ? error.message : String(error))
          }
          records.defer(
            record.id,
            records.get(record.id)?.reason ?? 'Waiting for receipt or manual review'
          )
        } else
          void deliver(record.id).catch((error) =>
            console.error('[hive] delivery persistence failed', error)
          )
      }
    } catch (error) {
      console.error('[hive] delivery scheduler failed', error)
    }
    if (!closing) {
      timer = setTimeout(tick, 1000)
      timer.unref()
    }
  }
  const wake = () => {
    if (closing || timer) return
    // Background work never inherits a request's temporary remote approval.
    withoutRemoteActionContext(() => {
      timer = setTimeout(tick, 0)
      timer.unref()
    })
  }
  wake()
  return {
    records,
    health,
    recheck,
    wake,
    deliver,
    drainReports(workspaceId: string, targetAgentId = `${workspaceId}:orchestrator`) {
      const entry = input.outbox.listPending(workspaceId, targetAgentId)[0]
      if (!entry || !input.agentRuntime.getActiveRunByAgentId(workspaceId, targetAgentId))
        return { attempted: 0, firstSyncError: null }
      void deliver(entry.receiptId).catch((error) =>
        console.error('[hive] report delivery persistence failed', error)
      )
      return { attempted: active.has(entry.receiptId) ? 1 : 0, firstSyncError: null }
    },
    async close() {
      closing = true
      clearTimeout(timer)
      for (const entry of active.values()) entry.abort.abort()
      await Promise.allSettled([...active.values()].map((entry) => entry.done))
      readers.clear()
    },
    prepareCancellation(workspaceId: string, id: string, recipientId: string, reason: string) {
      input.db.transaction(() => {
        records.requestCancellation(workspaceId, id, recipientId, reason)
        health.cancel(id)
      })()
    },
    interrupt(id: string) {
      active.get(id)?.abort.abort()
      wake()
    },
    stopImpact(workspaceId: string, workerId: string) {
      return input.db
        .prepare(
          "SELECT id AS dispatch_id,text AS task_text,status FROM dispatches WHERE workspace_id=? AND to_agent_id=? AND status IN ('queued','submitted') ORDER BY created_at,sequence"
        )
        .all(workspaceId, workerId) as Array<{
        dispatch_id: string
        task_text: string
        status: string
      }>
    },
    view(workspaceId: string, workerId?: string) {
      const entries = records
        .list(workspaceId)
        .filter(
          (entry) =>
            !workerId || requireDispatch(workspaceId, entry.dispatch_id).toAgentId === workerId
        )
      const pending = entries.filter(
        (entry) => entry.state !== 'confirmed' && entry.state !== 'resolved'
      )
      return {
        deliveries: entries.map((entry) => ({
          ...publicDelivery(entry),
          task_text: requireDispatch(workspaceId, entry.dispatch_id).text,
          recipient_name: input.workspaceStore.getAgent(workspaceId, entry.recipient_id).name,
        })),
        health: health.list(workspaceId, workerId),
        oldest_pending_ms: pending.length
          ? pending.reduce((oldest, entry) => Math.max(oldest, Date.now() - entry.created_at), 0)
          : 0,
        receipt_latencies_ms: entries
          .filter((entry) => entry.confirmed_at !== null)
          .map((entry) => ({
            delivery_id: entry.id,
            latency_ms: (entry.confirmed_at ?? entry.created_at) - entry.created_at,
          })),
      }
    },
    resolve(
      workspaceId: string,
      id: string,
      action: 'handled' | 'resend',
      actor: string,
      reason: string
    ) {
      const record = records.get(id)
      if (!record || record.workspace_id !== workspaceId)
        throw new HttpError(404, 'Delivery not found')
      const dispatch = requireDispatch(workspaceId, record.dispatch_id)
      if (
        action === 'resend' &&
        record.kind === 'dispatch' &&
        (dispatch.status === 'cancelled' || dispatch.status === 'reported')
      )
        throw new ConflictError('Closed dispatch cannot be resent')
      const accepted = input.db.transaction(() => {
        records.resolve(id, actor, reason, action === 'resend')
        return action === 'handled' ? persistAccepted(record, false) : undefined
      })()
      readers.delete(id)
      if (accepted) notifyAccepted(record, accepted)
      wake()
    },
    acknowledge(workspaceId: string, id: string, workerId: string) {
      const record = records.get(id)
      const current = requireDispatch(workspaceId, id)
      if (!record || current.toAgentId !== workerId || record.workspace_id !== workspaceId)
        throw new HttpError(404, 'Dispatch not found for worker')
      if (current.status === 'cancelled' || current.status === 'reported')
        throw new ConflictError('Dispatch is closed')
      const accepted = input.db.transaction(() => {
        records.confirm(id, 'worker_ack')
        const dispatch = persistAccepted(record, false)
        health.start(id, 'worker_ack')
        return dispatch
      })()
      active.get(id)?.abort.abort()
      notifyAccepted(record, accepted)
      wake()
    },
  }
}
export type TeamDeliveryRuntime = ReturnType<typeof createTeamDeliveryRuntime>
