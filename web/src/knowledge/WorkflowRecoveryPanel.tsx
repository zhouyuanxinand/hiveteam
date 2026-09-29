import { AlertTriangle } from 'lucide-react'
import { useState } from 'react'
import type { WorkflowRecoveryIssue } from '../../../src/shared/workflows.js'
import { MessageDeliveryPanel } from '../activity/MessageDeliveryPanel.js'
import type { WorkflowRun } from '../api.js'
import { useI18n } from '../i18n.js'

export const WorkflowRecoveryPanel = ({ run }: { run: WorkflowRun }) => {
  const { language } = useI18n()
  const zh = language === 'zh'
  const [deliveryId, setDeliveryId] = useState<string | null>(null)
  const reasons: Record<WorkflowRecoveryIssue['reason'], string> = {
    delivery_unknown: zh ? '任务接收尚未确认' : 'Task receipt is unconfirmed',
    delivery_manual: zh ? '投递需要人工处理' : 'Delivery needs manual review',
    delivery_unavailable: zh ? '投递缺少可继续执行的依据' : 'Delivery cannot safely continue',
    delivery_blocked: zh
      ? '收件人的队列被另一条投递阻塞'
      : 'Another delivery blocks this recipient’s queue',
    dispatch_cancelled: zh
      ? '当前任务已取消，需要决定是否重跑'
      : 'This task was cancelled; decide whether to rerun it',
    cancellation_unconfirmed: zh
      ? '尚未确认原任务已经停止'
      : 'The original task has not been confirmed stopped',
  }
  return (
    <>
      {run.status === 'interrupted' ? (
        <section
          className="workflow-recovery"
          aria-label={zh ? '工作流需要处理' : 'Workflow needs attention'}
        >
          <p className="workflow-recovery__heading">
            <AlertTriangle size={16} aria-hidden />
            <strong>{zh ? '后续步骤已暂停' : 'New steps are paused'}</strong>
          </p>
          <p>
            {zh
              ? '现有任务的汇报仍会保存。核对原终端并处理下方记录；确认依据补齐后会继续原任务。'
              : 'Reports from existing tasks are still saved. Check the original terminal and review the records below. The original task can continue once the uncertainty is resolved.'}
          </p>
          {run.recoveryIssues.length ? (
            <ul className="workflow-recovery__issues">
              {run.recoveryIssues.map((issue) => (
                <li key={`${issue.step_id}:${issue.delivery_id}:${issue.reason}`}>
                  <p>
                    <strong>
                      {zh ? '步骤 ' : 'Step '}
                      {issue.step_id}
                    </strong>{' '}
                    · {reasons[issue.reason]}
                  </p>
                  {issue.detail ? (
                    <p className="workflow-recovery__detail">{issue.detail}</p>
                  ) : null}
                  {issue.delivery_id ? (
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={
                        (zh ? '查看步骤 ' : 'Review delivery for step ') +
                        issue.step_id +
                        (zh ? ' 的投递' : '')
                      }
                      aria-expanded={deliveryId === issue.delivery_id}
                      onClick={() => setDeliveryId(issue.delivery_id)}
                    >
                      {zh ? '查看投递' : 'Review delivery'}
                    </button>
                  ) : (
                    <p>
                      {zh
                        ? '可停止本次工作流，或在步骤详情中显式请求重跑。'
                        : 'Stop this workflow, or explicitly request a rerun from the step details.'}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
      {deliveryId ? (
        <div className="workflow-recovery__delivery">
          <button type="button" className="icon-btn" onClick={() => setDeliveryId(null)}>
            {zh ? '收起投递记录' : 'Close delivery details'}
          </button>
          <MessageDeliveryPanel
            key={`${run.workspaceId}:${deliveryId}`}
            workspaceId={run.workspaceId}
            initialDeliveryId={deliveryId}
          />
        </div>
      ) : null}
    </>
  )
}
