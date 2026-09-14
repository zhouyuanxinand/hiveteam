import { LockKeyhole, RotateCcw } from 'lucide-react'
import { useState } from 'react'
import type {
  TerminalSessionRecovery,
  TerminalSessionRetryStatus,
} from '../../../src/shared/terminal-recovery.js'
import { useI18n } from '../i18n.js'

export const SessionRecoveryBanner = ({
  recovery,
  retry,
  connected,
}: {
  recovery: TerminalSessionRecovery
  retry: () => Promise<TerminalSessionRetryStatus>
  connected: boolean
}) => {
  const { t } = useI18n()
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<TerminalSessionRetryStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const retryOriginal = async () => {
    if (pending) return
    setPending(true)
    setError(null)
    setResult(null)
    try {
      setResult(await retry())
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      setPending(false)
    }
  }
  return (
    <section
      aria-label={t('terminal.recovery.title')}
      className="max-h-[50%] shrink-0 overflow-y-auto border-b border-[var(--border)] bg-[var(--bg-2)] px-4 py-3 text-sm text-pri"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-64">
          <p role="status" className="flex items-center gap-2 font-semibold">
            <LockKeyhole size={16} className="shrink-0" aria-hidden />
            {t('terminal.recovery.title')}
          </p>
          <p className="mt-1 max-w-prose text-sec">{t('terminal.recovery.description')}</p>
        </div>
        <button
          type="button"
          className="icon-btn icon-btn--primary h-auto min-h-9 max-w-full shrink-0 whitespace-normal py-2"
          disabled={pending || !connected}
          onClick={() => void retryOriginal()}
        >
          <RotateCcw size={14} aria-hidden />
          {t(pending ? 'terminal.recovery.retrying' : 'terminal.recovery.retry')}
        </button>
      </div>
      {recovery.thread_id ? (
        <p className="mt-2 break-all text-xs text-sec">
          {t('terminal.recovery.session')} <code>{recovery.thread_id}</code>
        </p>
      ) : null}
      <details className="mt-2 text-sec">
        <summary className="cursor-pointer text-pri">{t('terminal.recovery.help')}</summary>
        <p className="mt-2 max-w-prose">{t('terminal.recovery.release')}</p>
        <p className="mt-2 max-w-prose">{t('terminal.recovery.preserve')}</p>
      </details>
      {result === 'still_locked' || result === 'retry_pending' ? (
        <p role="status" className="mt-2">
          {t('terminal.recovery.stillLocked')}
        </p>
      ) : null}
      {result === 'unavailable' ? (
        <p role="status" className="mt-2">
          {t('terminal.recovery.unavailable')}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 break-words text-[var(--status-red)]">
          {t('terminal.recovery.failed')} {error}
        </p>
      ) : null}
    </section>
  )
}
