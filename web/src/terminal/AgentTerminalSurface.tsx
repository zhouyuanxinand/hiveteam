import { useLayoutEffect, useRef, useState } from 'react'
import { ConversationTurns } from './ConversationTurns.js'
import { useConversationCopy } from './conversation-copy.js'
import { useAgentConversation } from './useAgentConversation.js'

export const AgentTerminalSurface = ({
  workspaceId,
  agentId,
  runId,
  slot,
}: {
  workspaceId: string
  agentId: string
  runId: string
  slot: 'worker' | 'orch'
}) => {
  const copy = useConversationCopy()
  const { data, failed, retry } = useAgentConversation(workspaceId, agentId, runId)
  const [mode, setMode] = useState<'auto' | 'conversation' | 'terminal'>('auto')
  const scroll = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const canRead = data?.status !== 'unsupported'
  const showConversation =
    canRead && (mode === 'conversation' || (mode === 'auto' && !!data?.turns.length))
  // biome-ignore lint/correctness/useExhaustiveDependencies: New content changes the scroll height; don't move readers who scrolled up.
  useLayoutEffect(() => {
    const node = scroll.current
    if (node && following.current) node.scrollTop = node.scrollHeight
  }, [data, showConversation])
  return (
    <div className="agent-terminal-surface flex h-full min-h-0 w-full min-w-0 flex-col">
      {canRead ? (
        <fieldset className="conversation-toolbar" aria-label={copy.conversation}>
          <button
            type="button"
            className="icon-btn"
            aria-pressed={!!showConversation}
            onClick={() => setMode('conversation')}
          >
            {copy.conversation}
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-pressed={!showConversation}
            onClick={() => setMode('terminal')}
          >
            {copy.terminal}
          </button>
        </fieldset>
      ) : null}
      {showConversation ? (
        <div
          className="conversation-scroll"
          ref={scroll}
          onScroll={(event) => {
            const node = event.currentTarget
            following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 64
          }}
        >
          {failed ? (
            <div role="alert" className="conversation-notice">
              {copy.error}{' '}
              <button type="button" className="icon-btn" onClick={retry}>
                {copy.retry}
              </button>
            </div>
          ) : null}
          {!data ? <p role="status">{copy.loading}</p> : null}
          {data && !data.turns.length ? <p role="status">{copy.pending}</p> : null}
          {data?.truncated ? <p className="text-xs text-ter">{copy.truncated}</p> : null}
          <ConversationTurns turns={data?.turns ?? []} />
        </div>
      ) : null}
      <div hidden={!!showConversation} className="min-h-0 flex-1">
        <div
          id={`${slot}-pty-${runId}`}
          className="flex h-full w-full"
          data-pty-slot={slot === 'orch' ? 'orchestrator' : 'worker'}
        />
      </div>
    </div>
  )
}
