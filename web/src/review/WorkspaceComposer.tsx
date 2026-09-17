import { ChevronDown, ChevronRight, FileText, Send } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
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
  recipient,
}: {
  workspaceId: string
  onOpenPlans?: () => void
  recipient?: { id: string; name: string }
}) => {
  // Recipient changes remount the stateful editor; drafts and request IDs never cross members.
  return (
    <RecipientComposer
      key={`${workspaceId}:${recipient?.id ?? 'orchestrator'}`}
      workspaceId={workspaceId}
      {...(onOpenPlans ? { onOpenPlans } : {})}
      {...(recipient ? { recipient } : {})}
    />
  )
}

const RecipientComposer = ({
  workspaceId,
  onOpenPlans,
  recipient,
}: {
  workspaceId: string
  onOpenPlans?: () => void
  recipient?: { id: string; name: string }
}) => {
  const copy = useReviewCopy()
  const labelId = useId()
  const answerRef = useRef<HTMLTextAreaElement>(null)
  const [expanded, setExpanded] = useState(!!recipient)
  const key = `hive:answer:${workspaceId}${recipient ? `:${recipient.id}` : ''}`
  const [initial] = useState(() => readDraft(key))
  const [draft, setDraft] = useState(initial.draft)
  const [storageError, setStorageError] = useState(initial.failed)
  const hasDraft = !!(draft.text.trim() || draft.question.trim())
  const delivery = useReviewSubmission(
    workspaceId,
    null,
    initial.draft.attempted ? initial.draft.request_id : null
  )
  useEffect(() => {
    if (expanded && !recipient) answerRef.current?.focus()
  }, [expanded, recipient])
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
      reviewRequest<ReviewSubmission>(workspaceId, '/answer', 'POST', {
        ...draft,
        ...(recipient ? { agent_id: recipient.id } : {}),
      })
    )
  }
  return (
    <section className="workspace-composer">
      <div className="review-toolbar">
        {recipient ? (
          <label htmlFor={`${labelId}-answer`} className="font-medium">
            {copy.replyTo} {recipient.name}
          </label>
        ) : (
          <div className="review-actions">
            <button
              type="button"
              className="icon-btn icon-btn--link workspace-composer-toggle"
              aria-expanded={expanded}
              aria-controls={`${labelId}-form`}
              aria-describedby={!expanded && hasDraft ? `${labelId}-draft` : undefined}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? (
                <ChevronDown size={14} aria-hidden />
              ) : (
                <ChevronRight size={14} aria-hidden />
              )}
              {copy.supplementaryReply}
            </button>
            {!expanded && hasDraft ? (
              <span id={`${labelId}-draft`} className="text-xs text-sec">
                {copy.replyDraft}
              </span>
            ) : null}
          </div>
        )}
        {onOpenPlans ? (
          <button type="button" className="icon-btn" onClick={onOpenPlans}>
            <FileText size={15} aria-hidden />
            {copy.plans}
          </button>
        ) : null}
      </div>
      <form
        id={`${labelId}-form`}
        hidden={!expanded}
        className="workspace-composer-form"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <p className="text-xs text-sec">{recipient ? copy.memberOnly : copy.supplementaryHint}</p>
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
          ref={answerRef}
          id={`${labelId}-answer`}
          aria-label={recipient ? undefined : copy.answer}
          aria-describedby={`${labelId}-hint`}
          className="review-input"
          rows={3}
          value={draft.text}
          maxLength={4000}
          placeholder={recipient ? copy.placeholder : copy.supplementaryPlaceholder}
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
      </form>
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
    </section>
  )
}
