import { Check, Send } from 'lucide-react'
import { useId, useState } from 'react'

import { acceptDispatchReport, type DispatchSummary, sendDispatchFeedback } from '../api.js'
import { useI18n } from '../i18n.js'

export const DispatchReport = ({
  dispatch,
  onChanged,
}: {
  dispatch: DispatchSummary
  onChanged: () => void
}) => {
  const { t } = useI18n()
  const feedbackId = useId()
  const [feedback, setFeedback] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (dispatch.state !== 'reported') return null

  const canAccept =
    !dispatch.acceptedAt && (!dispatch.reportOutcome || dispatch.reportOutcome === 'success')
  const act = async (action: 'accept' | 'feedback') => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      if (action === 'accept') {
        await acceptDispatchReport(dispatch.workspaceId, dispatch.id, dispatch.reportRevision)
      } else {
        await sendDispatchFeedback(dispatch.workspaceId, dispatch.id, feedback.trim())
        setFeedback('')
      }
      onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="dispatch-report">
      <div className="dispatch-report-state" data-outcome={dispatch.reportOutcome ?? 'unknown'}>
        <strong>{t(`delivery.outcome.${dispatch.reportOutcome ?? 'unknown'}`)}</strong>
        <span>{t(dispatch.acceptedAt ? 'delivery.accepted' : 'delivery.unaccepted')}</span>
      </div>
      <p className="dispatch-report-body">{dispatch.reportText}</p>
      {dispatch.artifacts.length > 0 ? (
        <ul className="dispatch-report-artifacts" aria-label={t('delivery.artifacts')}>
          {[...new Set(dispatch.artifacts)].map((path) => (
            <li key={path}>
              <code>{path}</code>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="dispatch-report-note">{t('delivery.acceptanceHint')}</p>
      {error ? (
        <p className="dispatch-report-error" role="alert">
          {error}
        </p>
      ) : null}
      {canAccept ? (
        <button
          type="button"
          className="activity-center-diff-button"
          disabled={busy}
          onClick={() => void act('accept')}
        >
          <Check size={14} aria-hidden /> {t('delivery.accept')}
        </button>
      ) : null}
      <label htmlFor={feedbackId}>{t('delivery.feedback')}</label>
      <textarea
        id={feedbackId}
        value={feedback}
        onChange={(event) => setFeedback(event.target.value)}
        maxLength={10000}
        rows={2}
        disabled={busy}
      />
      <button
        type="button"
        className="activity-center-diff-button"
        disabled={busy || !feedback.trim()}
        onClick={() => void act('feedback')}
      >
        <Send size={14} aria-hidden /> {t('delivery.sendFeedback')}
      </button>
    </div>
  )
}
