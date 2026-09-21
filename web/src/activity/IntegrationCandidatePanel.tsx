import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { CodeReviewVersion } from '../../../src/shared/code-review.js'
import type {
  IntegrationCandidate,
  IntegrationCandidateView,
} from '../../../src/shared/integration-candidate.js'
import type { VerificationProfile } from '../../../src/shared/verification-profile.js'
import { apiFetch, readErrorMessage } from '../api.js'
import { useI18n } from '../i18n.js'
import { isRemoteMode } from '../remote/remote-permissions-api.js'
import { readCodeReview } from './code-review-api.js'
import { VerificationLog } from './VerificationLog.js'
import { VerificationProfiles } from './VerificationProfiles.js'
import { fromRun, type RunPayload, updateDispatchVerification } from './verification-api.js'
import './delivery-quality.css'

export const IntegrationCandidatePanel = ({
  workspaceId,
  dispatchId,
  onChanged,
}: {
  workspaceId: string
  dispatchId: string
  onChanged: () => void
}) => {
  const { language } = useI18n(),
    zh = language === 'zh',
    formId = useId(),
    remote = isRemoteMode()
  const [items, setItems] = useState<IntegrationCandidate[]>([]),
    [selected, setSelected] = useState('')
  const [view, setView] = useState<IntegrationCandidateView | null>(null),
    [version, setVersion] = useState<CodeReviewVersion | null>(null)
  const [profile, setProfile] = useState<VerificationProfile | null>(null),
    [note, setNote] = useState('')
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const generation = useRef(0)
  const base = `/api/ui/workspaces/${encodeURIComponent(workspaceId)}/dispatches/${encodeURIComponent(dispatchId)}/integration-candidates`
  const request = useCallback(
    async (suffix = '', body?: unknown) => {
      const response = await apiFetch(
        `${base}${suffix}`,
        body === undefined
          ? undefined
          : {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            }
      )
      if (!response.ok) throw new Error(await readErrorMessage(response, 'Candidate action failed'))
      return response.json()
    },
    [base]
  )
  const load = useCallback(async () => {
    const current = ++generation.current
    try {
      const list: IntegrationCandidate[] = await request()
      const nextId = selected || list[0]?.id
      const payload = nextId
        ? ((await request(`/${encodeURIComponent(nextId)}`)) as Omit<
            IntegrationCandidateView,
            'verification'
          > & { verification: RunPayload | null })
        : null
      const next = payload
        ? { ...payload, verification: payload.verification ? fromRun(payload.verification) : null }
        : null
      const source = await readCodeReview(workspaceId, dispatchId)
      if (current !== generation.current) return
      setItems(list)
      setView(next)
      setVersion(source.version)
      setError('')
    } catch (cause) {
      if (current === generation.current) setError(String(cause))
    }
  }, [request, selected, workspaceId, dispatchId])
  useEffect(() => {
    void load()
    return () => {
      generation.current++
    }
  }, [load])
  const running =
    view?.candidate.state === 'queued' ||
    view?.candidate.state === 'preparing' ||
    ['queued', 'running'].includes(view?.verification?.state ?? '')
  useEffect(() => {
    if (!running || busy) return
    let disposed = false
    const poll = async () => {
      await load()
      if (!disposed) timer = window.setTimeout(() => void poll(), 2500)
    }
    let timer = window.setTimeout(() => void poll(), 2500)
    return () => {
      disposed = true
      window.clearTimeout(timer)
    }
  }, [running, busy, load])
  const act = async (
    action:
      | 'prepare'
      | 'continue'
      | 'verify'
      | 'review'
      | 'accept'
      | 'integrate'
      | 'abandon'
      | 'cancel'
  ) => {
    if (busy) return
    setBusy(true)
    setError('')
    generation.current++
    try {
      const c = view?.candidate
      if (action === 'prepare') {
        const next = (await request('', { version })) as IntegrationCandidate
        setSelected(next.id)
      } else if (action === 'cancel' && view?.verification)
        await updateDispatchVerification(workspaceId, dispatchId, view.verification.id, 'cancel')
      else if (c) {
        await request(`/${encodeURIComponent(c.id)}/${action}`, {
          candidate_sha: c.candidate_sha,
          target_sha: c.target_sha,
          verification_id: view?.verification?.id,
          profile_id: profile?.id,
          note,
        })
        if (action === 'review') setNote('')
        if (action === 'integrate') onChanged()
      }
      await load()
    } catch (cause) {
      setError(String(cause))
    } finally {
      setBusy(false)
    }
  }
  const stateNames = {
    queued: zh ? '等待资源' : 'Queued',
    preparing: zh ? '正在准备' : 'Preparing',
    conflicted: zh ? '需要解决冲突' : 'Conflicts need resolution',
    prepared: zh ? '等待验收' : 'Prepared',
    failed: zh ? '准备失败' : 'Preparation failed',
    stale: zh ? '已过期' : 'Stale',
    integrating: zh ? '集成待核对' : 'Integration needs reconciliation',
    integrated: zh ? '已集成' : 'Integrated',
    abandoned: zh ? '已放弃（保留现场）' : 'Abandoned; directory retained',
  }
  return (
    <section className="delivery-quality" aria-label={zh ? '组合候选' : 'Integration candidates'}>
      <h3>{zh ? '在当前目标上组合交付' : 'Combine delivery with the current target'}</h3>
      <p>
        {zh
          ? '分叉后先准备独立候选，再对组合后的代码验证、审查和接受，最后更新本地目标。'
          : 'Prepare an isolated candidate, verify and review the combined code, accept it, then update the local target.'}
      </p>
      <div className="delivery-quality-actions">
        <button type="button" className="icon-btn" disabled={busy} onClick={() => void load()}>
          {zh ? '刷新版本' : 'Refresh versions'}
        </button>
        {!remote ? (
          <button
            type="button"
            className="icon-btn"
            disabled={busy || !version}
            onClick={() => void act('prepare')}
          >
            {zh ? '基于当前目标准备候选' : 'Prepare candidate on current target'}
          </button>
        ) : null}
      </div>
      {version ? (
        <dl>
          <dt>{zh ? '源提交' : 'Source'}</dt>
          <dd>
            <code>{version.source_sha}</code>
          </dd>
          <dt>{zh ? '当前目标' : 'Current target'}</dt>
          <dd>
            <code>{version.base_sha}</code>
          </dd>
        </dl>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      {items.length ? (
        <>
          <label htmlFor={`${formId}-candidate`}>{zh ? '候选记录' : 'Candidate history'}</label>
          <select
            id={`${formId}-candidate`}
            value={view?.candidate.id ?? ''}
            disabled={busy}
            onChange={(e) => {
              setSelected(e.target.value)
              setNote('')
            }}
          >
            {items.map((item) => (
              <option key={item.id} value={item.id}>
                {stateNames[item.state]} · {new Date(item.created_at).toLocaleString()} ·{' '}
                {item.candidate_sha?.slice(0, 12) ?? item.id.slice(0, 8)}
              </option>
            ))}
          </select>
        </>
      ) : (
        <p>{zh ? '尚无组合候选。' : 'No integration candidates yet.'}</p>
      )}
      {view ? (
        <>
          <strong>{stateNames[view.candidate.state]}</strong>
          <dl>
            <dt>{zh ? '候选提交' : 'Candidate commit'}</dt>
            <dd>
              <code>{view.candidate.candidate_sha ?? '—'}</code>
            </dd>
            <dt>{zh ? '候选目录' : 'Candidate directory'}</dt>
            <dd>
              <code>{view.candidate.checkout_path}</code>
            </dd>
          </dl>
          {view.stale_reason || view.candidate.error ? (
            <p role="status">{view.stale_reason ?? view.candidate.error}</p>
          ) : null}
          {view.candidate.state === 'conflicted' || view.candidate.state === 'failed' ? (
            <>
              <p>
                {zh
                  ? '在上述目录解决并暂存冲突，然后继续；放弃会保留目录。'
                  : 'Resolve and stage conflicts in this directory, then continue. Abandoning retains the directory.'}
              </p>
              <ul>
                {view.conflicts.map((path) => (
                  <li key={path}>
                    <code>{path}</code>
                  </li>
                ))}
              </ul>
              {!remote ? (
                <button
                  className="icon-btn"
                  type="button"
                  disabled={busy}
                  onClick={() => void act('continue')}
                >
                  {zh ? '继续准备候选' : 'Continue candidate preparation'}
                </button>
              ) : null}
            </>
          ) : null}
          {view.candidate.candidate_sha ? (
            <details open>
              <summary>{zh ? '组合差异' : 'Combined diff'}</summary>
              <pre className="dispatch-verification-output">
                {view.patch || (zh ? '没有文本差异' : 'No text diff')}
              </pre>
              {view.truncated ? (
                <p>
                  {zh
                    ? '展示已截断，请在候选目录检查完整差异。'
                    : 'Preview truncated; inspect the complete diff in the candidate directory.'}
                </p>
              ) : null}
            </details>
          ) : null}
          {view.verification ? (
            <>
              <p>
                {zh ? '候选验证' : 'Candidate verification'}: {view.verification.state} ·{' '}
                {view.verification.error}
              </p>
              <VerificationLog key={view.verification.id} run={view.verification} />
              {!remote && ['queued', 'running'].includes(view.verification.state) ? (
                <button
                  type="button"
                  className="icon-btn"
                  disabled={busy}
                  onClick={() => void act('cancel')}
                >
                  {zh ? '取消此验证' : 'Cancel this verification'}
                </button>
              ) : null}
            </>
          ) : null}
          {!remote && view.candidate.state === 'prepared' ? (
            <>
              <VerificationProfiles
                workspaceId={workspaceId}
                requireProfile
                selected={profile}
                onSelect={setProfile}
                disabled={busy || running}
              />
              <button
                className="icon-btn"
                type="button"
                disabled={busy || running || !!view.stale_reason || !profile}
                onClick={() => void act('verify')}
              >
                {zh ? '验证组合候选' : 'Verify candidate'}
              </button>
              <label htmlFor={`${formId}-note`}>
                {zh ? '对当前候选的审查意见' : 'Review of this candidate'}
              </label>
              <textarea
                id={`${formId}-note`}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                maxLength={16000}
              />
              <button
                className="icon-btn"
                type="button"
                disabled={busy || !!view.stale_reason || !note.trim()}
                onClick={() => void act('review')}
              >
                {zh ? '记录候选审查通过' : 'Record approving candidate review'}
              </button>
              {view.candidate.review_note ? <p>{view.candidate.review_note}</p> : null}
              <div className="delivery-quality-actions">
                <button
                  className="icon-btn"
                  type="button"
                  disabled={busy || !view.can_accept}
                  onClick={() => void act('accept')}
                >
                  {zh ? '接受此候选版本' : 'Accept this candidate version'}
                </button>
                <button
                  className="icon-btn"
                  type="button"
                  disabled={busy || !view.can_integrate}
                  onClick={() => void act('integrate')}
                >
                  {zh ? '更新本地目标分支' : 'Update local target branch'}
                </button>
              </div>
            </>
          ) : null}
          {view.candidate.state === 'integrating' && !remote ? (
            <button
              type="button"
              className="icon-btn"
              disabled={busy}
              onClick={() => void act('integrate')}
            >
              {zh ? '核对并恢复集成' : 'Reconcile interrupted integration'}
            </button>
          ) : null}
          <details>
            <summary>{zh ? '候选审计历史' : 'Candidate audit history'}</summary>
            <ol>
              {view.history.map((event) => (
                <li key={event.id}>
                  {new Date(event.recorded_at).toLocaleString()} ·{' '}
                  {stateNames[event.snapshot.state]}
                  {event.snapshot.review_note ? <p>{event.snapshot.review_note}</p> : null}
                  {event.snapshot.error ? <p>{event.snapshot.error}</p> : null}
                </li>
              ))}
            </ol>
          </details>
          {!remote &&
          !['preparing', 'integrating', 'integrated', 'abandoned'].includes(
            view.candidate.state
          ) ? (
            <button
              className="icon-btn"
              type="button"
              disabled={busy || running}
              onClick={() => void act('abandon')}
            >
              {zh ? '放弃候选并保留现场' : 'Abandon candidate and retain directory'}
            </button>
          ) : null}
        </>
      ) : null}
    </section>
  )
}
