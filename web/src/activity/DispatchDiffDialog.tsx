import * as Dialog from '@radix-ui/react-dialog'
import { AlertTriangle, Check, Copy, FileDiff, RefreshCw, Send, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import {
  type DispatchDiff,
  type DispatchSummary,
  getDispatchDiff,
  sendDispatchFeedback,
} from '../api.js'
import { useI18n } from '../i18n.js'

interface DispatchDiffDialogProps {
  dispatch: DispatchSummary | null
  onClose: () => void
  /** Called after feedback was delivered so the parent can refresh. */
  onFeedbackSent?: () => void
  open: boolean
  targetLabel: string
  workspaceId: string
}

type PatchLineKind = 'add' | 'del' | 'file' | 'hunk' | 'meta'

const classifyPatchLine = (line: string): PatchLineKind | null => {
  if (line.startsWith('diff --git') || line.startsWith('index ')) return 'file'
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('+++') || line.startsWith('---')) return 'meta'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  return null
}

export const DispatchDiffDialog = ({
  dispatch,
  onClose,
  onFeedbackSent,
  open,
  targetLabel,
  workspaceId,
}: DispatchDiffDialogProps) => {
  const { t } = useI18n()
  const [diff, setDiff] = useState<DispatchDiff | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [sending, setSending] = useState(false)
  const [feedbackSent, setFeedbackSent] = useState(false)

  const dispatchId = dispatch?.id ?? null

  useEffect(() => {
    if (!open || !dispatchId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    setDiff(null)
    setCopied(false)
    setFeedback('')
    setFeedbackSent(false)
    getDispatchDiff(workspaceId, dispatchId)
      .then((result) => {
        if (!cancelled) setDiff(result)
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : String(loadError))
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [dispatchId, open, workspaceId])

  const patchLines = useMemo(() => (diff ? diff.patch.split('\n') : []), [diff])

  const copyPatch = async () => {
    if (!diff) return
    try {
      await navigator.clipboard.writeText(diff.patch)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch (copyError: unknown) {
      setError(copyError instanceof Error ? copyError.message : String(copyError))
    }
  }

  // A rename-only diff has no +/- lines but is still a real change, so gate
  // the empty state on the patch text itself rather than on line kinds.
  const hasPatch = (diff?.patch.trim().length ?? 0) > 0

  const sendFeedback = async () => {
    if (!dispatchId || sending) return
    setSending(true)
    setError(null)
    try {
      await sendDispatchFeedback(workspaceId, dispatchId, feedback.trim())
      setFeedback('')
      setFeedbackSent(true)
      window.setTimeout(() => setFeedbackSent(false), 3000)
      onFeedbackSent?.()
    } catch (sendError: unknown) {
      setError(sendError instanceof Error ? sendError.message : String(sendError))
    } finally {
      setSending(false)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="app-overlay fixed inset-0 z-[60]" />
        <div className="pointer-events-none fixed inset-0 z-[70] grid place-items-center p-4">
          <Dialog.Content
            className="dialog-scale-pop elev-2 pointer-events-auto flex h-[min(760px,calc(100vh-32px))] max-h-[calc(100vh-32px)] w-[min(860px,calc(100vw-32px))] flex-col overflow-hidden rounded-lg border"
            style={{
              background: 'var(--bg-elevated)',
              borderColor: 'var(--border-bright)',
            }}
            data-testid="dispatch-diff-dialog"
          >
            <header className="dispatch-diff-header">
              <div className="flex min-w-0 items-center gap-3">
                <div className="activity-center-heading-icon" aria-hidden>
                  <FileDiff size={18} />
                </div>
                <div className="min-w-0">
                  <Dialog.Title className="text-lg font-semibold text-pri">
                    {t('activity.diff.title')}
                  </Dialog.Title>
                  <Dialog.Description className="mt-0.5 text-xs text-ter">
                    {targetLabel} ·{' '}
                    {t('activity.diff.baseline', {
                      sha:
                        diff?.baseHeadSha.slice(0, 7) ?? dispatch?.baseHeadSha?.slice(0, 7) ?? '—',
                    })}
                  </Dialog.Description>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  className="activity-center-icon-button"
                  onClick={() => void copyPatch()}
                  disabled={!diff || loading}
                  aria-label={t('activity.diff.copyPatch')}
                  title={t('activity.diff.copyPatch')}
                >
                  <Copy size={15} aria-hidden />
                  {copied ? <span className="sr-only">{t('activity.copied')}</span> : null}
                </button>
                <Dialog.Close asChild>
                  <button
                    type="button"
                    className="activity-center-icon-button"
                    aria-label={t('common.close')}
                  >
                    <X size={16} aria-hidden />
                  </button>
                </Dialog.Close>
              </div>
            </header>

            {error ? (
              <div className="activity-center-message activity-center-message--error" role="alert">
                <AlertTriangle size={14} aria-hidden /> {error}
              </div>
            ) : null}

            <div className="dispatch-diff-body scroll-y">
              {loading ? (
                <div className="activity-center-empty">
                  <RefreshCw size={20} className="animate-spin" aria-hidden />
                  {t('activity.diff.loading')}
                </div>
              ) : diff ? (
                <>
                  {diff.truncated ? (
                    <p className="dispatch-diff-note" role="note">
                      <AlertTriangle size={13} aria-hidden /> {t('activity.diff.truncated')}
                    </p>
                  ) : null}
                  {diff.untrackedFiles.length > 0 ? (
                    <section className="dispatch-diff-untracked">
                      <h4>{t('activity.diff.untracked')}</h4>
                      <ul>
                        {diff.untrackedFiles.map((file) => (
                          <li key={file}>
                            <code>{file}</code>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ) : null}
                  {hasPatch ? (
                    <pre className="dispatch-diff-patch" data-testid="dispatch-diff-patch">
                      {patchLines.map((line, index) => {
                        const kind = classifyPatchLine(line)
                        return (
                          <span
                            // biome-ignore lint/suspicious/noArrayIndexKey: patch lines have no stable identity
                            key={index}
                            className={
                              kind
                                ? `dispatch-diff-line dispatch-diff-line--${kind}`
                                : 'dispatch-diff-line'
                            }
                          >
                            {line}
                            {'\n'}
                          </span>
                        )
                      })}
                    </pre>
                  ) : (
                    <p className="activity-center-muted">{t('activity.diff.empty')}</p>
                  )}
                </>
              ) : null}
            </div>

            <footer className="dispatch-diff-footer">
              <div className="dispatch-diff-feedback-row">
                <textarea
                  value={feedback}
                  onChange={(event) => setFeedback(event.target.value)}
                  placeholder={t('activity.diff.feedbackPlaceholder', { name: targetLabel })}
                  rows={2}
                  className="dispatch-diff-feedback-input"
                  data-testid="dispatch-feedback-input"
                  disabled={sending}
                />
                <button
                  type="button"
                  className="icon-btn icon-btn--primary dispatch-diff-feedback-send"
                  disabled={feedback.trim().length === 0 || sending || !dispatch}
                  onClick={() => void sendFeedback()}
                  data-testid="dispatch-feedback-send"
                >
                  <Send size={13} aria-hidden />
                  {sending ? t('activity.diff.sending') : t('activity.diff.sendFeedback')}
                </button>
              </div>
              {feedbackSent ? (
                <p className="dispatch-diff-feedback-sent" role="status">
                  <Check size={13} aria-hidden /> {t('activity.diff.feedbackSent')}
                </p>
              ) : null}
            </footer>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
