import type { DispatchMessage } from '../shared/dispatch-messages.js'
import {
  type CreateDispatchMessageInput,
  createDispatchMessageStore,
} from './dispatch-message-store.js'
import { publicDelivery } from './message-delivery-store.js'
import { wrapUntrustedPromptData } from './prompt-safety.js'
import type { Database } from './sqlite.js'
import type { TeamDeliveryRuntime } from './team-delivery-runtime.js'

export const dispatchMessageGuidance = (dispatchId: string) =>
  [
    'message_protocol_version: 1',
    `Read all pages with team messages --dispatch ${dispatchId} before reporting.`,
    'Address incoming messages and explicitly pass --seen-seq <required_seen_seq> with team report.',
    'Reading messages or receiving terminal input does not confirm understanding. Never guess a future sequence.',
    `Use team message --dispatch ${dispatchId} --kind question --stdin to ask the Orchestrator; use --kind answer --reply-to <message-id> for a reply.`,
  ].join('\n')

export const buildDispatchMessagePayload = (message: DispatchMessage) =>
  [
    '[HiveTeam system message: dispatch conversation]',
    `dispatch_id: ${message.dispatch_id}`,
    `message_id: ${message.id}`,
    `sequence: ${message.sequence}`,
    `kind: ${message.kind}`,
    `from_agent_id: ${message.from_agent_id}`,
    `reply_to: ${message.reply_to ?? 'none'}`,
    wrapUntrustedPromptData('dispatch-message', message.body, 8192),
    `Read context with team messages --dispatch ${message.dispatch_id}. This message does not create or complete a task.`,
    ...(message.kind === 'question'
      ? [
          `Answer with team message --dispatch ${message.dispatch_id} --kind answer --reply-to ${message.id} --stdin.`,
        ]
      : []),
    'If you own this dispatch, address incoming messages before reporting with --seen-seq <required_seen_seq>.',
    '',
  ].join('\n')

export const createDispatchMessageRuntime = (
  db: Database,
  delivery: TeamDeliveryRuntime,
  assertWorkspaceWritable: (workspaceId: string) => void
) => {
  const messages = createDispatchMessageStore(db)
  return {
    list: messages.list,
    send(
      workspaceId: string,
      dispatchId: string,
      actorId: string,
      input: CreateDispatchMessageInput
    ) {
      assertWorkspaceWritable(workspaceId)
      const message = messages.create(workspaceId, dispatchId, actorId, input)
      const record = delivery.records.get(message.id)
      if (!record) throw new Error('Dispatch message has no durable delivery record')
      delivery.wake()
      return { ...message, delivery: publicDelivery(record) }
    },
  }
}
export type DispatchMessageRuntime = ReturnType<typeof createDispatchMessageRuntime>
