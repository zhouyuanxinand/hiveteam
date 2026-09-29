import type { MessageDelivery } from './message-delivery.js'

export const DISPATCH_MESSAGE_KINDS = ['note', 'question', 'answer', 'progress'] as const
export type DispatchMessageKind = (typeof DISPATCH_MESSAGE_KINDS)[number]
export const DISPATCH_MESSAGE_MAX_BYTES = 8 * 1024
export const DISPATCH_MESSAGE_PAGE_LIMIT = 100

export interface DispatchMessage {
  id: string
  dispatch_id: string
  sequence: number
  from_agent_id: string
  to_agent_id: string
  kind: DispatchMessageKind
  reply_to: string | null
  body: string
  created_at: number
}

export interface DispatchMessagePage {
  message_protocol_version: 0 | 1
  messages: Array<DispatchMessage & { delivery: MessageDelivery }>
  required_seen_seq: number
  latest_seq: number
  next_after: number | null
}
