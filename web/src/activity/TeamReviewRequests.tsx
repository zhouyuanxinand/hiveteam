import { lazy, Suspense, useEffect, useState } from 'react'
import type { TeamReviewView } from '../../../src/shared/team-review.js'
import { useI18n } from '../i18n.js'
import { isRemoteMode } from '../remote/remote-permissions-api.js'
import { readTeamReviews } from './team-review-api.js'

const WorktreeResourcesPanel = lazy(() =>
  import('./WorktreeResourcesPanel.js').then((module) => ({
    default: module.WorktreeResourcesPanel,
  }))
)
export const TeamReviewRequests = ({
  workspaceId,
  dispatchId,
  refreshKey,
}: {
  workspaceId: string
  dispatchId: string
  refreshKey: string
}) => {
  const { language } = useI18n(),
    zh = language === 'zh'
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<TeamReviewView[] | null>(null)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const [resourcesOpen, setResourcesOpen] = useState(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey follows the parent review version; revision explicitly reloads history.
  useEffect(() => {
    if (!open) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    setError('')
    const load = async () => {
      try {
        const records = await readTeamReviews(workspaceId, dispatchId)
        if (disposed) return
        setItems(records)
        if (records.some((item) => item.reviewer_retired_at === null && item.state !== 'failed'))
          timer = setTimeout(() => void load(), 5000)
      } catch (cause) {
        if (!disposed) setError(cause instanceof Error ? cause.message : String(cause))
      }
    }
    void load()
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [workspaceId, dispatchId, open, refreshKey, revision])
  const stateText = (item: TeamReviewView) =>
    ({
      preparing: zh ? '准备审查目录' : 'Preparing checkout',
      queued: zh ? '等待启动或投递' : 'Queued',
      submitted: zh ? '审查中' : 'Reviewing',
      failed: zh ? '需要处理' : 'Needs attention',
      reported: zh ? '已提交报告' : 'Reported',
      cancelled: zh ? '已取消' : 'Cancelled',
    })[item.state]
  const staleText = (reason: NonNullable<TeamReviewView['stale_reason']>) =>
    ({
      report_changed: zh ? '源报告已变化' : 'Source report changed',
      code_changed: zh ? '源提交已变化' : 'Source commit changed',
      baseline_changed: zh ? '比较基线已变化' : 'Comparison baseline changed',
      repository_changed: zh ? '源仓库已变化' : 'Source repository changed',
      uncommitted_changes: zh ? '源目录存在未提交改动' : 'Source has uncommitted changes',
      unavailable: zh ? '当前源版本不可用' : 'Current source is unavailable',
    })[reason]
  return (
    <details
      className="team-review-requests"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>{zh ? '临时成员审查' : 'Temporary reviewer tasks'}</summary>
      <p className="dispatch-report-note">
        {zh
          ? '展示最近 50 次审查。报告绑定发起时的提交与报告版本；验证、人工接受和集成仍需单独完成。'
          : 'The latest 50 requests retain the commit and report revision originally assigned. Verification, desktop acceptance and integration remain separate.'}
      </p>
      <button type="button" className="icon-btn" onClick={() => setRevision((value) => value + 1)}>
        {zh ? '刷新审查任务' : 'Refresh review tasks'}
      </button>
      {error ? (
        <p role="alert" className="dispatch-report-error">
          {error}
        </p>
      ) : null}
      {!items && !error ? (
        <p role="status">{zh ? '正在读取审查任务…' : 'Loading review tasks…'}</p>
      ) : null}
      {items?.length === 0 ? (
        <p>
          {zh
            ? '还没有临时审查任务。可由 Orchestrator 使用 team review 发起。'
            : 'No temporary reviews yet. The Orchestrator can request one with team review.'}
        </p>
      ) : null}
      {items?.map((item) => (
        <details key={item.id} className="team-review-request" open>
          <summary>
            {item.focus} · {stateText(item)}
          </summary>
          <p className="code-review-version">
            {zh ? '报告版本' : 'Report revision'} {item.source_report_revision} ·{' '}
            <code title={item.source_base_sha}>{item.source_base_sha.slice(0, 12)}</code> →{' '}
            <code title={item.source_head_sha}>{item.source_head_sha.slice(0, 12)}</code>
          </p>
          {item.stale_reason ? (
            <p role="status">
              {zh ? '历史意见已过期：' : 'Historical findings are stale: '}
              {staleText(item.stale_reason)}
            </p>
          ) : null}
          {item.last_error ? <p className="dispatch-report-error">{item.last_error}</p> : null}
          {item.report_text ? <p className="code-review-summary">{item.report_text}</p> : null}
          {item.report_outcome ? (
            <p>
              {zh ? '报告结果' : 'Reported outcome'}: {item.report_outcome}
            </p>
          ) : null}
          {item.artifacts.length ? (
            <ul>
              {item.artifacts.map((path) => (
                <li key={path}>
                  <code>{path}</code>
                </li>
              ))}
            </ul>
          ) : null}
          <p className="dispatch-report-note">
            {zh ? '审查成员' : 'Reviewer'}: <code>{item.reviewer_id}</code> ·{' '}
            {item.reviewer_retired_at === null
              ? zh
                ? '尚未退役'
                : 'Active member'
              : zh
                ? '已退役，证据保留'
                : 'Retired; evidence retained'}
          </p>
          <details>
            <summary>{zh ? '查看任务与保留目录' : 'Task and retained directory'}</summary>
            <dl className="dispatch-integration-paths">
              <dt>{zh ? '审查请求' : 'Review request'}</dt>
              <dd>
                <code>{item.id}</code>
              </dd>
              <dt>{zh ? '审查派单' : 'Review dispatch'}</dt>
              <dd>
                <code>{item.review_dispatch_id ?? (zh ? '尚未创建' : 'Not created yet')}</code>
              </dd>
              <dt>{zh ? '工作目录' : 'Working directory'}</dt>
              <dd>
                <code>{item.working_directory ?? (zh ? '尚未准备' : 'Not prepared yet')}</code>
              </dd>
            </dl>
            {item.worktree_dirty ? (
              <p role="status">
                {zh
                  ? '目录存在改动，已保留全部文件；请检查后再显式清理。'
                  : 'The checkout has changes. All files are retained; inspect them before explicit cleanup.'}
              </p>
            ) : null}
            {item.worktree_error ? (
              <p className="dispatch-report-error">{item.worktree_error}</p>
            ) : null}
            {item.working_directory && !isRemoteMode() ? (
              <button type="button" className="icon-btn" onClick={() => setResourcesOpen(true)}>
                {zh ? '查看工作树资源' : 'Inspect worktree resources'}
              </button>
            ) : null}
          </details>
        </details>
      ))}
      {resourcesOpen ? (
        <section aria-label={zh ? '保留的工作树资源' : 'Retained worktree resources'}>
          <button type="button" className="icon-btn" onClick={() => setResourcesOpen(false)}>
            {zh ? '收起资源' : 'Hide resources'}
          </button>
          <Suspense fallback={<p role="status">{zh ? '加载资源…' : 'Loading resources…'}</p>}>
            <WorktreeResourcesPanel />
          </Suspense>
        </section>
      ) : null}
    </details>
  )
}
