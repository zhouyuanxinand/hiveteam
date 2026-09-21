import { RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type {
  CodeReviewConclusion,
  CodeReviewContext,
  CodeReviewRecord,
  CodeReviewStaleReason,
} from '../../../src/shared/code-review.js'
import { useI18n } from '../i18n.js'
import { isRemoteMode } from '../remote/remote-permissions-api.js'
import { acceptCodeReview, readCodeReview, submitCodeReview } from './code-review-api.js'
import './code-review.css'

const staleText = (reason: CodeReviewStaleReason, zh: boolean) =>
  ({
    repository_changed: zh ? '仓库已变化' : 'Repository changed',
    report_changed: zh ? '报告版本已变化' : 'Report revision changed',
    code_changed: zh ? '代码提交已变化' : 'Source commit changed',
    baseline_changed: zh ? '比较基线已变化' : 'Comparison baseline changed',
    uncommitted_changes: zh ? '存在未提交的改动' : 'Uncommitted changes exist',
    unavailable: zh ? '当前版本不可审查' : 'Current version is unavailable',
    superseded: zh ? '已有更新的审查意见' : 'A newer review supersedes this one',
  })[reason]
const conclusionText = (value: CodeReviewConclusion, zh: boolean) =>
  ({
    approve: zh ? '建议通过' : 'Approve',
    changes_requested: zh ? '需要修改' : 'Changes requested',
    comment: zh ? '仅供参考' : 'Comment',
  })[value]

export const CodeReviewPanel = ({
  workspaceId,
  dispatchId,
  onChanged,
}: {
  workspaceId: string
  dispatchId: string
  onChanged: () => void
}) => {
  const { language } = useI18n(),
    zh = language === 'zh'
  const remote = isRemoteMode()
  const formId = useId()
  const [context, setContext] = useState<CodeReviewContext | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [summary, setSummary] = useState('')
  const [conclusion, setConclusion] = useState<CodeReviewConclusion>('comment')
  const generation = useRef(0)
  const request = useRef<{ body: string; id: string } | null>(null)
  const load = useCallback(async () => {
    const current = ++generation.current
    const next = await readCodeReview(workspaceId, dispatchId)
    if (current === generation.current) setContext(next)
  }, [workspaceId, dispatchId])
  useEffect(() => {
    let disposed = false
    void load().catch((cause: unknown) => {
      if (!disposed) setError(cause instanceof Error ? cause.message : String(cause))
    })
    return () => {
      disposed = true
      generation.current++
    }
  }, [load])
  const act = async (action: 'refresh' | 'submit' | 'accept', review?: CodeReviewRecord) => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      if (action === 'submit' && context?.version) {
        const body = { version: context.version, conclusion, summary }
        const serialized = JSON.stringify(body)
        if (request.current?.body !== serialized)
          request.current = { body: serialized, id: crypto.randomUUID() }
        await submitCodeReview(workspaceId, dispatchId, { ...body, request_id: request.current.id })
        setSummary('')
        setConclusion('comment')
        request.current = null
        onChanged()
      } else if (action === 'accept' && review) {
        await acceptCodeReview(workspaceId, dispatchId, review)
        onChanged()
      }
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  const recordDetails = (review: CodeReviewContext['reviews'][number]) => (
    <>
      <p className="dispatch-report-note">
        {zh ? '审查人' : 'Reviewer'}:{' '}
        {review.reviewer_id === 'local_user'
          ? zh
            ? '本机用户'
            : 'Desktop user'
          : review.reviewer_id}{' '}
        · {new Date(review.created_at).toLocaleString()}
      </p>
      <p className="code-review-version">
        {zh ? '报告版本' : 'Report revision'} {review.report_revision} ·{' '}
        <code title={review.base_sha}>{review.base_sha.slice(0, 12)}</code> →{' '}
        <code title={review.source_sha}>{review.source_sha.slice(0, 12)}</code>
      </p>
      <p className="code-review-summary">{review.summary}</p>
      {review.stale_reason ? (
        <p role="status">
          {staleText(review.stale_reason, zh)}
          {review.accepted_at
            ? zh
              ? '；保留历史接受记录，当前已失效。'
              : '; the previous acceptance remains in history and is no longer current.'
            : ''}
        </p>
      ) : null}
      {review.accepted_at ? (
        <p className="dispatch-report-note">
          {zh ? '本机接受时间' : 'Accepted on desktop'}:{' '}
          {new Date(review.accepted_at).toLocaleString()}
        </p>
      ) : null}
      {review.can_accept && !remote ? (
        <button
          type="button"
          className="icon-btn icon-btn--primary"
          disabled={busy}
          onClick={() => void act('accept', review)}
        >
          {zh ? '接受此版本的审查' : 'Accept review for this version'}
        </button>
      ) : null}
    </>
  )
  const latest = context?.reviews[0]
  return (
    <section className="code-review-panel" aria-label={zh ? '代码审查' : 'Code review'}>
      <div className="dispatch-verification-version">
        <h3>{zh ? '代码审查' : 'Code review'}</h3>
        <button
          type="button"
          className="icon-btn"
          disabled={busy}
          onClick={() => void act('refresh')}
        >
          <RefreshCw size={14} aria-hidden />
          {zh ? '刷新版本' : 'Refresh version'}
        </button>
      </div>
      <p className="dispatch-report-note">
        {zh
          ? '审查意见与本机接受分别记录。审查通过后，仍需完成验证与集成。'
          : 'Review conclusions and desktop acceptance are recorded separately. Verification and integration remain separate steps.'}
      </p>
      {error ? (
        <p role="alert" className="dispatch-report-error">
          {error}
        </p>
      ) : null}
      {busy ? (
        <p role="status">
          {zh ? '正在核对并更新审查记录…' : 'Checking the version and updating review records…'}
        </p>
      ) : null}
      {!context ? (
        <p role="status">{zh ? '正在读取审查版本…' : 'Loading review version…'}</p>
      ) : (
        <>
          {context.version ? (
            <p className="code-review-version">
              {zh ? '基线' : 'Baseline'} (
              {context.baseline_kind === 'target_head'
                ? zh
                  ? '当前目标'
                  : 'current target'
                : zh
                  ? '派单起点'
                  : 'dispatch start'}
              ): <code>{context.version.base_sha}</code>
              <br />
              {zh ? '源提交' : 'Source'}: <code>{context.version.source_sha}</code>
              <br />
              {zh ? '报告版本' : 'Report revision'}: {context.version.report_revision}
            </p>
          ) : null}
          {context.unavailable_reason ? <p role="status">{context.unavailable_reason}</p> : null}
          {context.is_dirty ? (
            <p role="status">
              {zh ? '请先提交改动，再刷新并审查。' : 'Commit changes, then refresh and review.'}
            </p>
          ) : null}
          {context.accepted ? (
            <p role="status" className="dispatch-verification-accepted">
              {zh ? '当前版本审查已接受' : 'Review accepted for the current version'}
            </p>
          ) : null}
          <details open>
            <summary>{zh ? '本次比较的代码差异' : 'Diff for this comparison'}</summary>
            <pre className="dispatch-verification-output">
              {context.patch ||
                (zh
                  ? '两个提交之间没有可显示的文本差异。'
                  : 'No displayable diff between these commits.')}
            </pre>
            {context.patch_truncated ? (
              <p>
                {zh
                  ? '差异过长，仅显示部分；接受前请审查完整源码。'
                  : 'Only part of this diff is shown. Review the complete source before accepting.'}
              </p>
            ) : null}
            {context.omitted_sensitive_files > 0 ? (
              <p>
                {zh
                  ? `已隐藏 ${context.omitted_sensitive_files} 个敏感路径的差异。`
                  : `Diffs for ${context.omitted_sensitive_files} sensitive paths are hidden.`}
              </p>
            ) : null}
          </details>
          {latest ? (
            <section aria-label={zh ? '最新审查意见' : 'Latest review'}>
              <h4>{conclusionText(latest.conclusion, zh)}</h4>
              {recordDetails(latest)}
            </section>
          ) : (
            <p>
              {zh
                ? '还没有绑定此派单版本的审查意见。'
                : 'No versioned review has been recorded for this dispatch.'}
            </p>
          )}
          {remote ? (
            <p>
              {zh
                ? '远程查看为只读；请在本机记录或接受审查。'
                : 'Remote access is read-only. Record or accept reviews on the desktop.'}
            </p>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault()
                void act('submit')
              }}
            >
              <label htmlFor={`${formId}-conclusion`}>
                {zh ? '本机审查结论' : 'Desktop review conclusion'}
              </label>
              <select
                id={`${formId}-conclusion`}
                value={conclusion}
                disabled={busy}
                onChange={(event) => setConclusion(event.target.value as CodeReviewConclusion)}
              >
                {(['comment', 'changes_requested', 'approve'] as const).map((value) => (
                  <option key={value} value={value}>
                    {conclusionText(value, zh)}
                  </option>
                ))}
              </select>
              <label htmlFor={`${formId}-summary`}>{zh ? '审查意见' : 'Review notes'}</label>
              <textarea
                id={`${formId}-summary`}
                value={summary}
                maxLength={16000}
                rows={4}
                disabled={busy}
                onChange={(event) => setSummary(event.target.value)}
              />
              <button
                type="submit"
                className="icon-btn icon-btn--secondary"
                disabled={
                  busy ||
                  !summary.trim() ||
                  !context.version ||
                  context.is_dirty ||
                  !!context.unavailable_reason
                }
              >
                {zh ? '记录审查意见' : 'Record review'}
              </button>
            </form>
          )}
          {context.reviews.length > 1 ? (
            <details>
              <summary>
                {zh ? '历史审查意见' : 'Review history'} ({context.reviews.length - 1})
              </summary>
              {context.reviews.slice(1).map((review) => (
                <details key={review.id}>
                  <summary>
                    {conclusionText(review.conclusion, zh)} ·{' '}
                    {new Date(review.created_at).toLocaleString()}
                  </summary>
                  {recordDetails(review)}
                </details>
              ))}
            </details>
          ) : null}
        </>
      )}
    </section>
  )
}
