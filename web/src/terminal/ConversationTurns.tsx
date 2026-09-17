import { useEffect, useState } from 'react'
import type { ConversationTurn } from '../../../src/shared/agent-conversation.js'
import { ReviewMarkdown } from '../review/ReviewMarkdown.js'
import { useConversationCopy } from './conversation-copy.js'

const Turn = ({ turn }: { turn: ConversationTurn }) => {
  const copy = useConversationCopy()
  const [expanded, setExpanded] = useState(turn.status !== 'complete')
  useEffect(() => {
    setExpanded(turn.status !== 'complete')
  }, [turn.status])
  return (
    <section className="conversation-turn" aria-label={turn.prompt || copy.conversation}>
      {turn.prompt ? <p className="conversation-prompt">{turn.prompt}</p> : null}
      {turn.process.length > 0 ? (
        <details open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
          <summary>
            {copy.process} · {turn.process.length} · {copy[turn.status]}
          </summary>
          {expanded ? (
            <div className="conversation-process">
              <p className="text-xs text-ter">{copy.note}</p>
              {turn.process.map((item) => (
                <p key={item.id} className={item.kind === 'tool' ? 'mono' : undefined}>
                  {item.text}
                </p>
              ))}
            </div>
          ) : null}
        </details>
      ) : null}
      {turn.answer ? <ReviewMarkdown content={turn.answer} /> : null}
      {turn.status === 'interrupted' ? (
        <p className="text-sm text-sec">{copy.interrupted}</p>
      ) : null}
    </section>
  )
}
export const ConversationTurns = ({ turns }: { turns: ConversationTurn[] }) => (
  <>
    {turns.map((turn) => (
      <Turn key={turn.id} turn={turn} />
    ))}
  </>
)
