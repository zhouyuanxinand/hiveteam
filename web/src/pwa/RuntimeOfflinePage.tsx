import { KeyRound, Loader2, PlayCircle, RefreshCw, ServerCrash } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { useI18n } from '../i18n.js'
import { initializeUiSession } from '../ui-session.js'
import { silentReload } from '../useBeforeUnloadGuard.js'

const RECONNECT_INTERVAL_MS = 3000

interface RuntimeOfflinePageProps {
  sessionRequired?: boolean
  /**
   * Engage demo mode without leaving this view. Daemon-offline is exactly when
   * users most want to evaluate Hive without installing a CLI, so we surface a
   * Try Demo escape hatch alongside Retry.
   */
  onTryDemo?: () => void
}

/**
 * Full-screen replacement for the workspace content area when the Hive runtime
 * is unreachable or its UI session has expired at bootstrap. The session probe
 * only checks existing authorization; the trusted launcher must restore it.
 * Reload after recovery to fetch workspace data through the normal bootstrap.
 */
export const RuntimeOfflinePage = ({
  onTryDemo,
  sessionRequired = false,
}: RuntimeOfflinePageProps = {}) => {
  const { t } = useI18n()
  const [retrying, setRetrying] = useState(false)
  const aliveRef = useRef(true)

  // silentReload arms the beforeunload guard so this auto-recovery reload
  // doesn't surface the "Reload site?" close-confirmation dialog. Without it
  // both the Retry click and the 3s polling reload would be intercepted by
  // the always-on guard mounted in AppInner.
  const reload = useCallback(() => {
    if (typeof window === 'undefined') return
    silentReload()
  }, [])

  const probe = useCallback(async (): Promise<boolean> => {
    try {
      if (sessionRequired) {
        await initializeUiSession()
        return true
      }
      const response = await fetch('/api/version', { credentials: 'include' })
      return response.ok
    } catch {
      return false
    }
  }, [sessionRequired])

  useEffect(() => {
    aliveRef.current = true
    const interval = window.setInterval(async () => {
      if (!aliveRef.current) return
      if ((await probe()) && aliveRef.current) reload()
    }, RECONNECT_INTERVAL_MS)
    return () => {
      aliveRef.current = false
      window.clearInterval(interval)
    }
  }, [probe, reload])

  const handleRetry = async () => {
    setRetrying(true)
    try {
      if ((await probe()) && aliveRef.current) {
        reload()
        return
      }
    } finally {
      // Brief delay so users see the "retrying…" feedback even on a fast no-op.
      window.setTimeout(() => {
        if (aliveRef.current) setRetrying(false)
      }, 400)
    }
  }

  return (
    <div
      className="flex flex-1 items-center justify-center p-8"
      data-testid={sessionRequired ? 'ui-session-required-page' : 'runtime-offline-page'}
    >
      <div
        className="elev-1 flex max-w-md flex-col items-center gap-3 rounded border p-6 text-center"
        style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)' }}
      >
        <div
          className="flex h-12 w-12 items-center justify-center rounded-full"
          style={{ background: 'var(--bg-3)', color: 'var(--status-orange)' }}
        >
          {sessionRequired ? (
            <KeyRound size={24} aria-hidden />
          ) : (
            <ServerCrash size={24} aria-hidden />
          )}
        </div>
        <div className="font-semibold text-pri">
          {t(sessionRequired ? 'pwa.sessionRequired.title' : 'pwa.runtimeOffline.title')}
        </div>
        <div className="text-sec text-sm leading-relaxed">
          {t(sessionRequired ? 'pwa.sessionRequired.body' : 'pwa.runtimeOffline.body')}
        </div>
        <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
          <button
            type="button"
            className="icon-btn icon-btn--primary flex items-center gap-2"
            data-testid="runtime-offline-retry"
            disabled={retrying}
            onClick={() => {
              void handleRetry()
            }}
          >
            {retrying ? (
              <Loader2 size={12} className="animate-spin" aria-hidden />
            ) : (
              <RefreshCw size={12} aria-hidden />
            )}
            {retrying
              ? t('pwa.runtimeOffline.retrying')
              : t(sessionRequired ? 'pwa.sessionRequired.retry' : 'pwa.runtimeOffline.retry')}
          </button>
          {onTryDemo ? (
            <button
              type="button"
              className="icon-btn flex items-center gap-2"
              data-testid="runtime-offline-try-demo"
              onClick={onTryDemo}
            >
              <PlayCircle size={12} aria-hidden />
              {t('pwa.runtimeOffline.tryDemo')}
            </button>
          ) : null}
        </div>
        <div className="text-ter text-xs">
          {t(
            sessionRequired
              ? 'pwa.sessionRequired.autoReconnect'
              : 'pwa.runtimeOffline.autoReconnect'
          )}
        </div>
      </div>
    </div>
  )
}
