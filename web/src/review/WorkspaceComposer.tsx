import { FileText, Send } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import type { ReviewSubmission } from '../../../src/shared/workspace-review.js'
import { reviewRequest } from './review-api.js'
import { useReviewCopy } from './review-copy.js'
import { SubmissionStatus } from './SubmissionStatus.js'
import { useReviewSubmission } from './useReviewSubmission.js'
import './review.css'

interface AnswerDraft {
  text: string
  question: string
  request_id: string
  attempted?: boolean
}
const emptyDraft = (): AnswerDraft => ({ text: '', question: '', request_id: crypto.randomUUID() })
const readDraft = (key: string): { draft: AnswerDraft; failed: boolean } => {
  try {
    const text = localStorage.getItem(key)
    if (!text) return { draft: emptyDraft(), failed: false }
    const value = JSON.parse(text) as Partial<AnswerDraft>
    if (
      typeof value.text === 'string' &&
      typeof value.question === 'string' &&
      typeof value.request_id === 'string'
    )
      return { draft: value as AnswerDraft, failed: false }
    return { draft: emptyDraft(), failed: true }
  } catch {
    return { draft: emptyDraft(), failed: true }
  }
}

export const WorkspaceComposer = ({
  workspaceId,
  onOpenPlans,
}: {
  workspaceId: string
  onOpenPlans: () => void
}) => {
  const copy = useReviewCopy()
  const labelId = useId()
  const key = `hive:answer:${workspaceId}`
  const [initial] = useState(() => readDraft(key))
  const [draft, setDraft] = useState(initial.draft)
  const [storageError, setStorageError] = useState(initial.failed)
  const delivery = useReviewSubmission(
    workspaceId,
    null,
    initial.draft.attempted ? initial.draft.request_id : null
  )
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(draft))
      setStorageError(false)
    } catch {
      setStorageError(true)
    }
  }, [draft, key])
  useEffect(() => {
    if (
      delivery.submission?.status === 'submitted' &&
      delivery.submission.request_id === draft.request_id
    )
      setDraft(emptyDraft())
  }, [delivery.submission, draft.request_id])
  const change = (patch: Partial<AnswerDraft>) => {
    setDraft((value) => ({ ...value, ...patch, request_id: crypto.randomUUID(), attempted: false }))
    delivery.reset()
  }
  const submit = () => {
    if (!draft.text.trim() || delivery.busy) return
    setDraft((value) => ({ ...value, attempted: true }))
    void delivery.send(draft.request_id, () =>
      reviewRequest<ReviewSubmission>(workspaceId, '/answer', 'POST', draft)
    )
  }
  return (
    <form
      className="workspace-composer"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <div className="review-toolbar">
        <label id={labelId} htmlFor={`${labelId}-answer`} className="font-medium">
          {copy.answer}
        </label>
        <button type="button" className="icon-btn" onClick={onOpenPlans}>
          <FileText size={15} aria-hidden />
          {copy.plans}
        </button>
      </div>
      <details>
        <summary className="text-sec text-xs">{copy.question}</summary>
        <input
          aria-label={copy.question}
          value={draft.question}
          maxLength={1000}
          disabled={delivery.busy}
          onChange={(event) => change({ question: event.target.value })}
          className="review-input mt-2"
        />
      </details>
      <textarea
        id={`${labelId}-answer`}
        aria-describedby={`${labelId}-hint`}
        className="review-input"
        rows={3}
        value={draft.text}
        maxLength={4000}
        placeholder={copy.placeholder}
        disabled={delivery.busy}
        onChange={(event) => change({ text: event.target.value })}
        onKeyDown={(event) => {
          if (
            (event.ctrlKey || event.metaKey) &&
            event.key === 'Enter' &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault()
            submit()
          }
        }}
      />
      <div className="review-toolbar">
        <p id={`${labelId}-hint`} className="text-xs text-sec">
          {copy.answerHint}
        </p>
        <button
          className="icon-btn icon-btn--primary"
          type="submit"
          disabled={!draft.text.trim() || delivery.busy}
        >
          <Send size={14} aria-hidden />
          {delivery.busy ? copy.sendingButton : copy.send}
        </button>
      </div>
      {storageError ? (
        <p role="alert" className="review-error">
          {copy.storageError}
        </p>
      ) : null}
      <SubmissionStatus
        submission={delivery.submission}
        error={delivery.error}
        unresolved={!!delivery.requestId && !delivery.submission}
        onCheck={() => {
          if (delivery.requestId) void delivery.check(delivery.requestId)
        }}
      />
    </form>
  )
}
