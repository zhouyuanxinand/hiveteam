import { useEffect } from 'react'
import type { ConversationTurn } from '../../../src/shared/agent-conversation.js'
import { useI18n } from '../i18n.js'
import { useAgentConversation } from './useAgentConversation.js'

export const TerminalProcessState = ({
  workspaceId,
  agentId,
  runId,
  update,
}: {
  workspaceId: string
  agentId: string
  runId: string
  update: (turn: ConversationTurn | undefined, label: string) => void
}) => {
  const { data, failed } = useAgentConversation(workspaceId, agentId, runId)
  const { t } = useI18n()
  const label = t('terminal.expandProcess')
  useEffect(() => {
    update(failed ? undefined : data?.turns.at(-1), label)
  }, [data, failed, label, update])
  useEffect(() => () => update(undefined, label), [label, update])
  return null
}
