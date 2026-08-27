import { ArrowRight, CircleAlert, Send } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { TeamListItem } from '../../../src/shared/types.js'
import { type DispatchSummary, listWorkspaceDispatches } from '../api.js'
import { useI18n } from '../i18n.js'

interface DispatchPulseProps {
  workers: TeamListItem[]
  workspaceId: string
}

const ACTIVE_STATES = new Set<DispatchSummary['state']>(['queued', 'submitted', 'failed'])

const stateLabelKey = (state: DispatchSummary['state']) => {
  if (state === 'failed') return 'dispatchPulse.failed' as const
  if (state === 'submitted') return 'dispatchPulse.submitted' as const
  return 'dispatchPulse.queued' as const
}

export const DispatchPulse = ({ workers, workspaceId }: DispatchPulseProps) => {
  const { t } = useI18n()
  const [dispatches, setDispatches] = useState<DispatchSummary[]>([])
  const [loading, setLoading] = useState(false)

  const load = useCallback(
    async (showLoading = false) => {
      if (showLoading) setLoading(true)
      try {
        const next = await listWorkspaceDispatches(workspaceId, { limit: 20 })
        setDispatches(next.filter((dispatch) => ACTIVE_STATES.has(dispatch.state)).slice(-8))
      } catch {
        // The worker cards remain useful while the runtime is reconnecting. The
        // next interval retries without replacing a previously visible pulse.
      } finally {
        if (showLoading) setLoading(false)
      }
    },
    [workspaceId]
  )

  useEffect(() => {
    void load(true)
    const timer = window.setInterval(() => void load(), 1200)
    return () => window.clearInterval(timer)
  }, [load])

  const workerNames = useMemo(
    () => new Map(workers.map((worker) => [worker.id, worker.name] as const)),
    [workers]
  )

  if (loading && dispatches.length === 0) return null
  if (dispatches.length === 0) return null

  const agentName = (agentId: string | null, fallback: string) =>
    agentId === null || agentId === `${workspaceId}:orchestrator`
      ? t('dispatchPulse.orchestrator')
      : (workerNames.get(agentId) ?? fallback)

  return (
    <section
      className="dispatch-pulse"
      aria-label={t('dispatchPulse.title')}
      data-testid="dispatch-pulse"
    >
      <div className="dispatch-pulse-heading">
        <span className="dispatch-pulse-title">
          <Send size={13} aria-hidden /> {t('dispatchPulse.title')}
        </span>
        <span className="dispatch-pulse-count">{dispatches.length}</span>
      </div>
      <div className="dispatch-pulse-list">
        {dispatches.map((dispatch) => (
          <div
            className="dispatch-pulse-item"
            key={dispatch.id}
            data-testid={`dispatch-pulse-${dispatch.id}`}
          >
            <span
              className={`dispatch-pulse-line dispatch-pulse-line--${dispatch.state}`}
              aria-hidden
            >
              <span className="dispatch-pulse-dot" />
              <span className="dispatch-pulse-travel" />
              <ArrowRight size={12} />
            </span>
            <span className="dispatch-pulse-route">
              {agentName(dispatch.fromAgentId, t('dispatchPulse.orchestrator'))}
              <span aria-hidden>→</span>
              {agentName(dispatch.toAgentId, dispatch.toAgentId)}
            </span>
            <span className={`dispatch-pulse-state dispatch-pulse-state--${dispatch.state}`}>
              {dispatch.state === 'failed' ? <CircleAlert size={11} aria-hidden /> : null}
              {t(stateLabelKey(dispatch.state))}
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}
