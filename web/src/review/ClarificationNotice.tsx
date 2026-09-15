import type { TeamListItem } from '../../../src/shared/types.js'
import { useReviewCopy } from './review-copy.js'
import './review.css'

export const ClarificationNotice = ({
  workers,
  onOpen,
}: {
  workers: TeamListItem[]
  onOpen: (workerId: string) => void
}) => {
  const copy = useReviewCopy()
  const interviewers = workers.filter((worker) => worker.clarification?.active)
  if (!interviewers.length) return null
  return (
    <div className="clarification-notice">
      <p className="text-sm">{copy.clarification}</p>
      <div className="review-actions">
        {interviewers.map((worker) => (
          <button
            key={worker.id}
            type="button"
            className="icon-btn"
            onClick={() => onOpen(worker.id)}
          >
            {copy.openInterview} · {worker.name}
          </button>
        ))}
      </div>
    </div>
  )
}
