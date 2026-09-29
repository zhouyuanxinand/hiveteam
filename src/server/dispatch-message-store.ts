import { randomUUID } from 'node:crypto'
import {
  DISPATCH_MESSAGE_KINDS,
  DISPATCH_MESSAGE_MAX_BYTES,
  DISPATCH_MESSAGE_PAGE_LIMIT,
  type DispatchMessage,
  type DispatchMessageKind,
  type DispatchMessagePage,
} from '../shared/dispatch-messages.js'
import { BadRequestError, ForbiddenError, HttpError, PayloadTooLargeError } from './http-errors.js'
import { createMessageDeliveryStore, publicDelivery } from './message-delivery-store.js'
import type { Database } from './sqlite.js'

export class DispatchMessageConflict extends HttpError {
  constructor(
    readonly code: 'message_protocol_required' | 'dispatch_closed' | 'stale_seen_seq',
    message: string
  ) {
    super(409, message)
    this.name = 'DispatchMessageConflict'
  }
}

interface MessageDispatch {
  id: string
  workspace_id: string
  to_agent_id: string
  status: string
  message_protocol_version: 0 | 1
}

export interface CreateDispatchMessageInput {
  kind: DispatchMessageKind
  body: string
  replyTo?: string
}

export const createDispatchMessageStore = (db: Database) => {
  const deliveries = createMessageDeliveryStore(db)
  const get = (id: string) =>
    db.prepare('SELECT * FROM dispatch_messages WHERE id=?').get(id) as DispatchMessage | undefined
  const requireDispatch = (workspaceId: string, dispatchId: string, actorId: string) => {
    const dispatch = db
      .prepare(
        'SELECT id,workspace_id,to_agent_id,status,message_protocol_version FROM dispatches WHERE id=? AND workspace_id=?'
      )
      .get(dispatchId, workspaceId) as MessageDispatch | undefined
    if (!dispatch) throw new HttpError(404, 'Dispatch not found')
    if (actorId !== dispatch.to_agent_id && actorId !== `${workspaceId}:orchestrator`)
      throw new ForbiddenError(
        'Only the dispatch owner and workspace Orchestrator can access its messages'
      )
    return dispatch
  }
  const sequences = (dispatchId: string, actorId: string) =>
    db
      .prepare(
        'SELECT COALESCE(MAX(sequence),0) AS latest_seq,COALESCE(MAX(CASE WHEN to_agent_id=? THEN sequence END),0) AS required_seen_seq FROM dispatch_messages WHERE dispatch_id=?'
      )
      .get(actorId, dispatchId) as { latest_seq: number; required_seen_seq: number }

  return {
    get,
    create: db.transaction(
      (
        workspaceId: string,
        dispatchId: string,
        actorId: string,
        input: CreateDispatchMessageInput
      ) => {
        const dispatch = requireDispatch(workspaceId, dispatchId, actorId)
        if (dispatch.message_protocol_version !== 1)
          throw new DispatchMessageConflict(
            'message_protocol_required',
            'Create a new dispatch with message_protocol_version: 1; legacy dispatches use feedback.'
          )
        if (dispatch.status === 'reported' || dispatch.status === 'cancelled')
          throw new DispatchMessageConflict(
            'dispatch_closed',
            'Dispatch is closed. Use explicit feedback to request rework.'
          )
        if (!(DISPATCH_MESSAGE_KINDS as readonly string[]).includes(input.kind))
          throw new BadRequestError('kind must be note, question, answer, or progress')
        if (typeof input.body !== 'string' || !input.body.trim())
          throw new BadRequestError('Message body is required')
        if (Buffer.byteLength(input.body, 'utf8') > DISPATCH_MESSAGE_MAX_BYTES)
          throw new PayloadTooLargeError('Message body exceeds 8 KiB')
        const recipient =
          actorId === dispatch.to_agent_id ? `${workspaceId}:orchestrator` : dispatch.to_agent_id
        const parent = input.replyTo === undefined ? undefined : get(input.replyTo)
        if (
          input.replyTo !== undefined &&
          (!parent ||
            parent.dispatch_id !== dispatchId ||
            parent.from_agent_id !== recipient ||
            parent.to_agent_id !== actorId)
        )
          throw new BadRequestError('reply_to must name an incoming message in this dispatch')
        if (input.kind === 'answer' && parent?.kind !== 'question')
          throw new BadRequestError('An answer must reply_to an incoming question')
        const message: DispatchMessage = {
          id: randomUUID(),
          dispatch_id: dispatchId,
          sequence: sequences(dispatchId, actorId).latest_seq + 1,
          from_agent_id: actorId,
          to_agent_id: recipient,
          kind: input.kind,
          reply_to: input.replyTo ?? null,
          body: input.body,
          created_at: Date.now(),
        }
        db.prepare(
          'INSERT INTO dispatch_messages(id,dispatch_id,sequence,from_agent_id,to_agent_id,kind,reply_to,body,created_at) VALUES(?,?,?,?,?,?,?,?,?)'
        ).run(
          message.id,
          dispatchId,
          message.sequence,
          actorId,
          recipient,
          message.kind,
          message.reply_to,
          message.body,
          message.created_at
        )
        db.prepare(
          "INSERT INTO message_deliveries(id,workspace_id,dispatch_id,recipient_id,kind,state,created_at,next_attempt_at) VALUES(?,?,?,?,'message','pending',?,?)"
        ).run(
          message.id,
          workspaceId,
          dispatchId,
          recipient,
          message.created_at,
          message.created_at
        )
        return message
      }
    ).immediate,
    list: db.transaction(
      (
        workspaceId: string,
        dispatchId: string,
        actorId: string,
        after: number = 0,
        limit: number = 50
      ): DispatchMessagePage => {
        const dispatch = requireDispatch(workspaceId, dispatchId, actorId)
        if (
          !Number.isSafeInteger(after) ||
          after < 0 ||
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > DISPATCH_MESSAGE_PAGE_LIMIT
        )
          throw new BadRequestError('after must be a non-negative integer; limit must be 1–100')
        const messages = db
          .prepare(
            'SELECT * FROM dispatch_messages WHERE dispatch_id=? AND sequence>? ORDER BY sequence LIMIT ?'
          )
          .all(dispatchId, after, limit) as DispatchMessage[]
        const bounds = sequences(dispatchId, actorId)
        const last = messages.at(-1)?.sequence ?? after
        return {
          message_protocol_version: dispatch.message_protocol_version,
          ...bounds,
          next_after: last < bounds.latest_seq ? last : null,
          messages: messages.map((message) => {
            const delivery = deliveries.get(message.id)
            if (!delivery) throw new Error('Dispatch message has no durable delivery record')
            return { ...message, delivery: publicDelivery(delivery) }
          }),
        }
      }
    ),
    assertReportSeen(dispatchId: string, workerId: string, seenSeq = 0) {
      if (!Number.isSafeInteger(seenSeq) || seenSeq < 0)
        throw new BadRequestError('seen_seq must be a non-negative integer')
      const { latest_seq, required_seen_seq } = sequences(dispatchId, workerId)
      if (seenSeq > latest_seq) throw new BadRequestError('seen_seq is ahead of this dispatch')
      if (seenSeq < required_seen_seq)
        throw new DispatchMessageConflict(
          'stale_seen_seq',
          `Read team messages for this dispatch and address incoming messages through sequence ${required_seen_seq} before reporting with --seen-seq.`
        )
    },
    closePending(dispatchId: string) {
      db.prepare(
        "UPDATE message_deliveries SET state='resolved',next_attempt_at=NULL,reason='Dispatch closed; retained in message history' WHERE dispatch_id=? AND kind='message' AND state='pending'"
      ).run(dispatchId)
    },
  }
}
export type DispatchMessageStore = ReturnType<typeof createDispatchMessageStore>
