import type { WorkflowRun } from '../api.js'
import { useI18n } from '../i18n.js'
import { WorkflowRecoveryPanel } from './WorkflowRecoveryPanel.js'
import { WorkflowRunSteps } from './WorkflowRunSteps.js'
import './workflow-recovery.css'

export const WorkflowRunSummary = ({
  run,
  busy,
  onChanged,
  onStop,
}: {
  run: WorkflowRun
  busy: boolean
  onChanged: (run: WorkflowRun) => void
  onStop: (run: WorkflowRun) => void
}) => {
  const { t } = useI18n()
  const active = run.status === 'running' || run.status === 'interrupted'
  return (
    <div className="workflow-run-summary">
      <div className="workflow-run-summary__status">
        <span role="status">{t(`workflows.${run.status}`)}</span>
        <span>
          {t('workflows.steps', {
            completed: run.steps.filter((step) => step.status === 'completed').length,
            total: run.steps.length,
          })}
        </span>
        {active ? (
          <button type="button" className="icon-btn" disabled={busy} onClick={() => onStop(run)}>
            {t('workflows.stop')}
          </button>
        ) : null}
      </div>
      {run.error && run.status !== 'interrupted' ? <p>{run.error}</p> : null}
      <WorkflowRecoveryPanel run={run} />
      <WorkflowRunSteps run={run} onChanged={onChanged} />
      {run.steps
        .filter((step) => step.status === 'blocked' || step.status === 'awaiting_review')
        .map((step) => (
          <p key={step.id}>
            {step.worker}:{' '}
            {t(
              step.status === 'blocked' ? 'delivery.step.blocked' : 'delivery.step.awaiting_review'
            )}
          </p>
        ))}
    </div>
  )
}
