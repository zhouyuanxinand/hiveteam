import { useId, useState } from 'react'
import { apiFetch, fromWorkflowRunPayload, readErrorMessage, type WorkflowRun } from '../api.js'
import { useI18n } from '../i18n.js'
import { isRemoteMode } from '../remote/remote-permissions-api.js'
import '../activity/delivery-quality.css'
export const WorkflowRunSteps = ({
  run,
  onChanged,
}: {
  run: WorkflowRun
  onChanged: (run: WorkflowRun) => void
}) => {
  const { language } = useI18n(),
    zh = language === 'zh',
    id = useId()
  const [selected, setSelected] = useState(''),
    [reason, setReason] = useState(''),
    [ack, setAck] = useState(false)
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const [history, setHistory] = useState<Array<{
    step_id: string
    attempt: number
    dispatch_id: string
    invalidated_at: number | null
    reason: string | null
  }> | null>(null)
  const base = `/api/ui/workspaces/${encodeURIComponent(run.workspaceId)}/workflows/runs/${encodeURIComponent(run.id)}`
  const act = async (action: 'history' | 'rerun') => {
    setBusy(true)
    setError('')
    try {
      const step = run.steps.find((item) => item.id === selected)
      const response = await apiFetch(
        action === 'history'
          ? `${base}/attempts`
          : `${base}/steps/${encodeURIComponent(selected)}/rerun`,
        action === 'history'
          ? undefined
          : {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                expected_attempt: step?.attempt,
                reason,
                acknowledge_external_effects: ack,
              }),
            }
      )
      if (!response.ok) throw new Error(await readErrorMessage(response, 'Workflow action failed'))
      if (action === 'history') setHistory(await response.json())
      else {
        onChanged(fromWorkflowRunPayload(await response.json()))
        setSelected('')
        setReason('')
        setHistory(null)
      }
    } catch (cause) {
      setError(String(cause))
    } finally {
      setBusy(false)
    }
  }
  const names = {
    report_success: zh ? '成功报告' : 'Successful report',
    review_accepted: zh ? '审查接受' : 'Accepted review',
    verification_passed: zh ? '验证通过' : 'Passing verification',
  }
  return (
    <details className="delivery-quality">
      <summary>{zh ? '步骤、质量条件与重跑' : 'Steps, quality conditions and reruns'}</summary>
      {error ? <p role="alert">{error}</p> : null}
      <ol className="workflow-attempt-list">
        {run.steps.map((step) => (
          <li key={step.id}>
            <strong>
              {step.id} · {step.worker} · {zh ? '第' : 'Attempt'} {step.attempt ?? 0}{' '}
              {zh ? '次' : ''}
            </strong>
            <p>
              {step.reportText
                ? zh
                  ? '已收到执行报告'
                  : 'Execution report received'
                : step.status}{' '}
              ·{' '}
              {step.status === 'completed'
                ? zh
                  ? '推进条件已满足'
                  : 'Completion conditions satisfied'
                : (step.waitingFor ?? []).map((condition) => names[condition]).join(' / ')}
            </p>
            {step.quality ? (
              <p>
                {zh ? '全部满足：' : 'All required: '}
                {step.quality.all_of.map((condition) => names[condition]).join(' + ')}
              </p>
            ) : null}
            {step.error ? <p>{step.error}</p> : null}
            {!isRemoteMode() && !!step.attempt ? (
              <button
                className="icon-btn"
                type="button"
                disabled={busy || run.steps.some((item) => item.rerunPending)}
                onClick={() => {
                  setSelected(step.id)
                  setAck(false)
                }}
              >
                {zh ? '从此步骤重跑' : 'Rerun from this step'}
              </button>
            ) : null}
          </li>
        ))}
      </ol>
      {selected ? (
        <div className="delivery-quality-form">
          <p>
            {zh
              ? `将重跑 ${selected} 及其后继，保留独立结果；先等待运行中的后继确认取消。`
              : `Rerun ${selected} and its descendants, preserve independent results, and wait for active descendants to confirm cancellation.`}
          </p>
          <label htmlFor={`${id}-reason`}>{zh ? '重跑原因' : 'Rerun reason'}</label>
          <textarea
            id={`${id}-reason`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={4000}
            rows={2}
          />
          <label className="delivery-quality-check">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            {zh
              ? '如存在已发布结果，我已核对；重跑不会撤销远端操作。'
              : 'If external publications exist, I have reviewed them; rerunning will not undo them.'}
          </label>
          <button
            type="button"
            className="icon-btn"
            disabled={busy || !reason.trim()}
            onClick={() => void act('rerun')}
          >
            {zh ? '确认重跑' : 'Confirm rerun'}
          </button>
        </div>
      ) : null}
      <button
        type="button"
        className="icon-btn"
        disabled={busy}
        onClick={() => void act('history')}
      >
        {zh ? '查看执行历史' : 'View attempt history'}
      </button>
      {history ? (
        <ul>
          {history.map((entry) => (
            <li key={`${entry.step_id}:${entry.attempt}`}>
              {entry.step_id} · {entry.attempt} · <code>{entry.dispatch_id}</code>
              {entry.invalidated_at ? ` · ${entry.reason}` : ''}
            </li>
          ))}
        </ul>
      ) : null}
    </details>
  )
}
