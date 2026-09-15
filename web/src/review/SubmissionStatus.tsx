import type { ReviewSubmission } from '../../../src/shared/workspace-review.js'
import { useReviewCopy } from './review-copy.js'

export const SubmissionStatus = ({
  submission,
  error,
  onCheck,
  unresolved = false,
}: {
  submission: ReviewSubmission | null
  error: string
  onCheck: () => void
  unresolved?: boolean
}) => {
  const copy = useReviewCopy()
  return (
    <>
      {submission ? (
        <div className="review-status" role="status">
          <p>{copy[submission.status]}</p>
          {submission.error ? <p className="text-sec break-words">{submission.error}</p> : null}
          {submission.status === 'sending' || submission.status === 'uncertain' || error ? (
            <button type="button" className="icon-btn" onClick={onCheck}>
              {copy.retryStatus}
            </button>
          ) : null}
        </div>
      ) : null}
      {unresolved ? (
        <div className="review-status" role="status">
          <p>{copy.unresolved}</p>
          <button type="button" className="icon-btn" onClick={onCheck}>
            {copy.retryStatus}
          </button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="review-error">
          {error}
        </p>
      ) : null}
    </>
  )
}
