import { Check, RotateCcw, Save, Send } from 'lucide-react'
import { useEffect, useState } from 'react'
import {
  type ReviewDocumentState,
  type ReviewDraft,
  reviewDiff,
} from '../../../src/shared/workspace-review.js'
import { ReviewMarkdown } from './ReviewMarkdown.js'
import { reviewRequest, saveReviewDraft, submitReview } from './review-api.js'
import { useReviewCopy } from './review-copy.js'
import { SubmissionStatus } from './SubmissionStatus.js'
import { useReviewSubmission } from './useReviewSubmission.js'

interface LocalDraft {
  content: string
  note: string
  base_revision: string
  base_content: string
  expected_version: number
  request_id: string
  attempted?: boolean
}
const startingDraft = (state: ReviewDocumentState): LocalDraft => ({
  content: state.draft?.content ?? state.document.content,
  note: state.draft?.note ?? '',
  base_revision: state.draft?.base_revision ?? state.document.revision,
  base_content: state.draft?.base_content ?? state.document.content,
  expected_version: state.draft?.version ?? 0,
  request_id: crypto.randomUUID(),
})
const loadLocal = (key: string, state: ReviewDocumentState) => {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return { draft: startingDraft(state), failed: false }
    const draft = JSON.parse(raw) as LocalDraft
    if (
      ['content', 'note', 'base_revision', 'base_content', 'request_id'].every(
        (field) => typeof draft[field as keyof LocalDraft] === 'string'
      ) &&
      Number.isSafeInteger(draft.expected_version)
    )
      return { draft, failed: false }
  } catch {
    return { draft: startingDraft(state), failed: true }
  }
  return { draft: startingDraft(state), failed: true }
}

export const PlanEditor = ({
  workspaceId,
  state,
  onUpdate,
  onReload,
  onNavigate,
  documentPaths = [],
}: {
  workspaceId: string
  state: ReviewDocumentState
  onUpdate: (value: ReviewDocumentState) => void
  onReload: () => void
  onNavigate?: (path: string) => void
  documentPaths?: string[]
}) => {
  const copy = useReviewCopy()
  const key = `hive:plan-draft:${workspaceId}:${state.document.path}`
  const [initial] = useState(() => loadLocal(key, state))
  const [draft, setDraft] = useState(initial.draft)
  const [storageError, setStorageError] = useState(initial.failed)
  const [mode, setMode] = useState<'preview' | 'edit' | 'changes'>('preview')
  const [sourceView, setSourceView] = useState(false)
  const [saving, setSaving] = useState(false)
  const [initialSubmission] = useState(
    () => state.submissions.find((item) => item.request_id === initial.draft.request_id) ?? null
  )
  const delivery = useReviewSubmission(
    workspaceId,
    initialSubmission,
    initial.draft.attempted ? initial.draft.request_id : null
  )
  const conflict =
    draft.base_revision !== state.document.revision ||
    draft.expected_version !== (state.draft?.version ?? 0)
  const dirty =
    draft.content !== (state.draft?.content ?? state.document.content) ||
    draft.note !== (state.draft?.note ?? '') ||
    draft.base_revision !== (state.draft?.base_revision ?? state.document.revision)
  const busy = saving || delivery.busy
  const diff = reviewDiff(draft.base_content, draft.content)
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(draft))
      setStorageError(false)
    } catch {
      setStorageError(true)
    }
  }, [key, draft])
  const change = (patch: Partial<LocalDraft>) => {
    setDraft((value) => ({ ...value, ...patch, request_id: crypto.randomUUID(), attempted: false }))
    delivery.reset()
  }
  const save = async (): Promise<ReviewDraft> => {
    const saved = await saveReviewDraft(workspaceId, { path: state.document.path, ...draft })
    setDraft((value) => ({ ...value, expected_version: saved.version }))
    onUpdate({ ...state, draft: saved })
    return saved
  }
  const saveOnly = async () => {
    if (busy || conflict) return
    setSaving(true)
    delivery.setError('')
    try {
      await save()
    } catch (e) {
      delivery.setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }
  const send = () => {
    if (busy || conflict) return
    setDraft((value) => ({ ...value, attempted: true }))
    void delivery.send(draft.request_id, async () => {
      const saved = dirty || !state.draft ? await save() : state.draft
      return submitReview(workspaceId, draft.request_id, state.document.path, saved.version)
    })
  }
  const confirm = async () => {
    setSaving(true)
    delivery.setError('')
    try {
      const result = await reviewRequest<{ confirmed_revision: string }>(
        workspaceId,
        '/confirm',
        'POST',
        { path: state.document.path, revision: state.document.revision }
      )
      onUpdate({ ...state, ...result })
    } catch (e) {
      delivery.setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }
  const replaceDraft = () => {
    change({
      content: state.document.content,
      note: '',
      base_content: state.document.content,
      base_revision: state.document.revision,
      expected_version: state.draft?.version ?? 0,
    })
    setSourceView(false)
  }
  return (
    <div className="plan-editor">
      <div className="review-toolbar review-editor-header">
        <div>
          <p className="text-sm">{state.confirmed_revision ? copy.confirmed : copy.unconfirmed}</p>
          <p className="text-xs text-sec">
            {dirty ? copy.dirty : state.draft ? copy.savedDraft : copy.source}
          </p>
        </div>
        <button type="button" className="icon-btn" onClick={onReload} disabled={busy}>
          <RotateCcw size={14} aria-hidden />
          {copy.refresh}
        </button>
      </div>
      {conflict ? (
        <div role="alert" className="review-conflict">
          <p>{copy.changed}</p>
          <p>{copy.conflictHelp}</p>
          <div className="review-actions">
            <button
              type="button"
              className="icon-btn"
              onClick={() => {
                setSourceView(true)
                setMode('preview')
              }}
            >
              {copy.latestSource}
            </button>
            <button type="button" className="icon-btn" onClick={replaceDraft} disabled={busy}>
              {copy.sourceAction}
            </button>
          </div>
        </div>
      ) : null}
      <div className="review-tabs" role="tablist" aria-label={copy.title}>
        {(['preview', 'edit', 'changes'] as const).map((tab) => (
          <button
            type="button"
            key={tab}
            role="tab"
            id={`review-tab-${tab}`}
            aria-selected={mode === tab}
            aria-controls="review-editor-content"
            tabIndex={mode === tab ? 0 : -1}
            className={`icon-btn ${mode === tab ? 'active' : ''}`}
            onKeyDown={(event) => {
              const tabs = ['preview', 'edit', 'changes'] as const
              const index = tabs.indexOf(tab)
              const next =
                event.key === 'ArrowRight'
                  ? (index + 1) % 3
                  : event.key === 'ArrowLeft'
                    ? (index + 2) % 3
                    : event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? 2
                        : null
              if (next === null) return
              event.preventDefault()
              const nextTab = tabs[next]
              if (!nextTab) return
              setMode(nextTab)
              setSourceView(false)
              document.getElementById(`review-tab-${nextTab}`)?.focus()
            }}
            onClick={() => {
              setMode(tab)
              setSourceView(false)
            }}
          >
            {copy[tab]}
          </button>
        ))}
        {mode === 'preview' ? (
          <label className="review-source-toggle">
            <input
              type="checkbox"
              checked={sourceView}
              onChange={(event) => setSourceView(event.target.checked)}
            />
            {copy.source}
          </label>
        ) : null}
      </div>
      <div
        className="review-editor-content"
        id="review-editor-content"
        role="tabpanel"
        aria-labelledby={`review-tab-${mode}`}
      >
        {mode === 'preview' ? (
          <ReviewMarkdown
            content={sourceView ? state.document.content : draft.content}
            path={state.document.path}
            documentPaths={documentPaths}
            {...(onNavigate ? { onNavigate } : {})}
          />
        ) : mode === 'edit' ? (
          <textarea
            className="review-input review-document-input"
            aria-label={copy.draft}
            value={draft.content}
            maxLength={64000}
            disabled={busy}
            onChange={(event) => change({ content: event.target.value })}
          />
        ) : (
          <pre className="review-diff">{diff || copy.noDiff}</pre>
        )}
      </div>
      <footer className="review-editor-footer">
        <label className="text-sm">
          {copy.note}
          <textarea
            className="review-input mt-1"
            rows={2}
            maxLength={2000}
            value={draft.note}
            disabled={busy}
            onChange={(event) => change({ note: event.target.value })}
          />
        </label>
        <p className="text-xs text-sec">{copy.draftHint}</p>
        <SubmissionStatus
          submission={delivery.submission}
          error={delivery.error}
          unresolved={!!delivery.requestId && !delivery.submission}
          onCheck={() => {
            if (delivery.requestId) void delivery.check(delivery.requestId)
          }}
        />
        {storageError ? (
          <p role="alert" className="review-error">
            {copy.storageError}
          </p>
        ) : null}
        <div className="review-actions">
          <button
            type="button"
            className="icon-btn"
            disabled={busy || conflict || !dirty}
            onClick={() => {
              void saveOnly()
            }}
          >
            <Save size={14} aria-hidden />
            {copy.save}
          </button>
          <button
            type="button"
            className="icon-btn icon-btn--primary"
            disabled={busy || conflict || (!diff && !draft.note.trim())}
            onClick={send}
            title={copy.reviewHint}
          >
            <Send size={14} aria-hidden />
            {delivery.busy ? copy.sendingButton : copy.review}
          </button>
          <button
            type="button"
            className="icon-btn"
            disabled={
              busy ||
              dirty ||
              conflict ||
              draft.content !== state.document.content ||
              !!state.confirmed_revision
            }
            onClick={() => {
              void confirm()
            }}
            title={copy.confirmHint}
          >
            <Check size={14} aria-hidden />
            {copy.confirm}
          </button>
        </div>
        <p className="text-xs text-sec">{copy.reviewHint}</p>
        {draft.content !== state.document.content ? (
          <p className="text-xs text-sec">{copy.sourceMismatch}</p>
        ) : null}
      </footer>
    </div>
  )
}
