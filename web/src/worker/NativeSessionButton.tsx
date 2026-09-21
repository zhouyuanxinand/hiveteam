import * as Dialog from '@radix-ui/react-dialog'
import { History, X } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import type { NativeSessionContext, NativeSessionView } from '../../../src/shared/native-session.js'
import { apiFetch, readErrorMessage } from '../api.js'
import { useI18n } from '../i18n.js'
import { isRemoteMode } from '../remote/remote-permissions-api.js'

type View = NativeSessionView & { proposed_context: NativeSessionContext | null }
const reasons: Record<string, string> = {
  session_adapter_unverified: '当前 CLI 版本与平台尚未验证，自动分配和恢复已暂停。',
  session_allocation_uncertain:
    '上次分配可能已创建会话，但未保存结果。请核对原生会话后再选择新建。',
  session_missing: '原生会话文件已缺失。原绑定仍保留，可恢复文件或明确新建会话。',
  session_access_denied: '当前身份无法读取原生会话。请检查登录状态与目录权限后重试。',
  session_occupied: '成员正在运行，或进程退出尚未确认。请先停止成员并完成资源恢复。',
  session_identity_mismatch: 'CLI 返回的会话身份与绑定不一致。本次启动已停止，原绑定仍保留。',
  session_environment_mismatch: '工作目录、存储位置、CLI 或权限策略已变化。请核对后重新绑定环境。',
  session_native_failure: '原生会话操作失败。请查看最近启动错误后重试，原绑定仍保留。',
  session_changed: '会话已被其他操作更新，请刷新后重试。',
}

export const NativeSessionButton = ({
  workspaceId,
  agentId,
  running = false,
}: {
  workspaceId: string
  agentId: string
  running?: boolean
}) => {
  const { language } = useI18n(),
    zh = language === 'zh'
  const [open, setOpen] = useState(false),
    [view, setView] = useState<View | null>(null)
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [action, setAction] = useState<'new' | 'rebind' | null>(null)
  const [reason, setReason] = useState(''),
    [acknowledged, setAcknowledged] = useState(false)
  const reasonId = useId()
  const path = `/api/ui/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agentId)}/native-session`
  // biome-ignore lint/correctness/useExhaustiveDependencies: Manual refresh intentionally repeats the same authenticated query.
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setView(null)
    setError('')
    setAction(null)
    setReason('')
    setAcknowledged(false)
    void apiFetch(path, { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok)
          throw new Error(await readErrorMessage(response, 'Unable to load native session'))
        const value = (await response.json()) as View
        if (!controller.signal.aborted) setView(value)
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => controller.abort()
  }, [open, path, refresh])
  if (isRemoteMode()) return null
  const save = async () => {
    if (!view?.current || !action || !acknowledged || !reason.trim()) return
    setBusy(true)
    setError('')
    try {
      const response = await apiFetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action,
          expected_generation_id: view.current.id,
          expected_context: view.proposed_context,
          reason: reason.trim(),
          acknowledge: true,
        }),
      })
      if (!response.ok)
        throw new Error(await readErrorMessage(response, 'Unable to change native session'))
      setView((await response.json()) as View)
      setAction(null)
      setAcknowledged(false)
      setReason('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  const latest = view?.attempts[0]
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          className="icon-btn"
          aria-label={zh ? '会话与恢复' : 'Session and recovery'}
        >
          <History size={13} aria-hidden />
          {zh ? '会话与恢复' : 'Session and recovery'}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="app-overlay fixed inset-0 z-[70]" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-[71] max-h-[85vh] w-[min(36rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-white/10 p-5 text-sm"
          style={{ background: 'var(--bg-1)' }}
        >
          <div className="mb-3 flex items-center justify-between gap-3">
            <Dialog.Title className="text-base font-semibold">
              {zh ? '会话与恢复' : 'Session and recovery'}
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                className="icon-btn"
                aria-label={zh ? '关闭会话详情' : 'Close session details'}
              >
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>
          <Dialog.Description className="text-sec">
            {zh
              ? '核对当前原生会话与恢复条件。新建会话会保留旧绑定记录。'
              : 'Review the native session and recovery conditions. A new session preserves the previous binding history.'}
          </Dialog.Description>
          <button
            type="button"
            className="icon-btn mt-3"
            disabled={busy}
            onClick={() => setRefresh((value) => value + 1)}
          >
            {zh ? '刷新状态' : 'Refresh status'}
          </button>
          {error && (
            <p role="alert" className="mt-3 break-words text-danger">
              {error}
            </p>
          )}
          {!view && !error && (
            <p role="status" className="mt-4 text-sec">
              {zh ? '正在读取会话状态…' : 'Loading session status…'}
            </p>
          )}
          {view && !view.harness && (
            <p className="mt-4 text-sec">
              {zh
                ? '当前成员使用既有 CLI 会话恢复方式。此面板用于 Cursor 和 Grok。'
                : 'This member uses the existing CLI recovery path. This panel applies to Cursor and Grok.'}
            </p>
          )}
          {view?.harness && (
            <>
              <dl className="mt-5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">
                <dt className="text-sec">CLI</dt>
                <dd>{view.harness === 'cursor' ? 'Cursor' : 'Grok'}</dd>
                <dt className="text-sec">{zh ? '会话 ID' : 'Session ID'}</dt>
                <dd className="break-all font-mono text-xs leading-5">
                  {view.current?.native_id ?? (zh ? '尚未分配' : 'Not allocated')}
                </dd>
                <dt className="text-sec">{zh ? '代次' : 'Generation'}</dt>
                <dd>{view.current?.generation ?? '—'}</dd>
                <dt className="text-sec">{zh ? '最近启动核验' : 'Latest identity check'}</dt>
                <dd>
                  {latest?.state === 'active' || (latest?.state === 'closed' && latest.run_id)
                    ? zh
                      ? '身份已核验'
                      : 'Identity verified'
                    : zh
                      ? '尚未通过'
                      : 'Not verified'}
                </dd>
                <dt className="text-sec">{zh ? '外部占用' : 'External ownership'}</dt>
                <dd>{zh ? '未知' : 'Unknown'}</dd>
                <dt className="text-sec">{zh ? '自动投递' : 'Automatic input'}</dt>
                <dd>
                  {zh
                    ? '已暂停；就绪与收据尚未验证'
                    : 'Paused; readiness and receipts are unverified'}
                </dd>
              </dl>
              <p className="mt-4 break-words text-sec" role="status">
                {zh
                  ? view.reason_code
                    ? (reasons[view.reason_code] ?? view.reason)
                    : view.current?.native_id
                      ? '下次启动会按此 ID 核对并恢复。身份核验不代表任务已被模型接收。'
                      : '验证通过的 CLI 会在下次启动时分配并绑定会话 ID。'
                  : view.reason}
              </p>
              {view.current && (
                <>
                  <div className="mt-5 flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="icon-btn"
                      disabled={running || busy || view.reason_code === 'session_occupied'}
                      onClick={() => {
                        setAction('rebind')
                        setAcknowledged(false)
                      }}
                    >
                      {zh ? '重新绑定环境' : 'Rebind environment'}
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      disabled={running || busy || view.reason_code === 'session_occupied'}
                      onClick={() => {
                        setAction('new')
                        setAcknowledged(false)
                      }}
                    >
                      {zh ? '选择新会话' : 'Choose a new session'}
                    </button>
                  </div>
                  {action && (
                    <form
                      className="mt-4 space-y-3 border-t border-white/10 pt-4"
                      onSubmit={(event) => {
                        event.preventDefault()
                        void save()
                      }}
                    >
                      <p>
                        {action === 'new'
                          ? zh
                            ? '新代次在下次启动时分配 ID，旧会话不会被删除。'
                            : 'A new ID is allocated on the next start. The previous session is retained.'
                          : zh
                            ? '保留当前 ID，确认使用以下环境。恢复时仍会检查原生文件与身份。'
                            : 'Keep this ID and confirm the environment below. Recovery still checks native existence and identity.'}
                      </p>
                      <dl className="space-y-1 text-xs">
                        <dt className="text-sec">
                          {zh ? '当前工作目录' : 'Current working directory'}
                        </dt>
                        <dd className="break-all">{view.proposed_context?.cwd}</dd>
                        <dt className="pt-2 text-sec">
                          {zh ? '原生存储位置' : 'Native storage location'}
                        </dt>
                        <dd className="break-all">{view.proposed_context?.storage_root}</dd>
                        <dt className="pt-2 text-sec">
                          {zh ? '执行权限' : 'Execution permissions'}
                        </dt>
                        <dd>
                          {view.proposed_policy?.profile === 'trusted_unsafe'
                            ? zh
                              ? '宿主权限例外'
                              : 'Unsafe host access exception'
                            : zh
                              ? '受限执行'
                              : 'Restricted execution'}{' '}
                          · {view.proposed_policy?.role}
                        </dd>
                        <dt className="pt-2 text-sec">{zh ? '可写路径' : 'Writable paths'}</dt>
                        <dd className="break-all">
                          {view.proposed_policy?.write_roots.join(', ') || '—'}
                        </dd>
                      </dl>
                      <label className="block" htmlFor={reasonId}>
                        {zh ? '变更原因' : 'Reason for change'}
                      </label>
                      <textarea
                        id={reasonId}
                        className="w-full rounded-md border border-white/15 bg-transparent p-2"
                        rows={2}
                        maxLength={2000}
                        required
                        value={reason}
                        onChange={(event) => setReason(event.target.value)}
                      />
                      <label className="flex items-start gap-2 text-xs leading-5">
                        <input
                          type="checkbox"
                          className="mt-1"
                          checked={acknowledged}
                          onChange={(event) => setAcknowledged(event.target.checked)}
                        />
                        {zh
                          ? '我已核对会话与环境；此操作不会确认或重发旧任务。'
                          : 'I reviewed the session and environment. This does not acknowledge or resend earlier tasks.'}
                      </label>
                      <div className="flex gap-2">
                        <button
                          className="icon-btn icon-btn--primary"
                          type="submit"
                          disabled={busy || !acknowledged || !reason.trim()}
                        >
                          {busy ? (zh ? '保存中…' : 'Saving…') : zh ? '确认变更' : 'Confirm change'}
                        </button>
                        <button
                          className="icon-btn"
                          type="button"
                          disabled={busy}
                          onClick={() => setAction(null)}
                        >
                          {zh ? '取消' : 'Cancel'}
                        </button>
                      </div>
                    </form>
                  )}
                </>
              )}
              {view.history.length > 0 && (
                <details className="mt-5 border-t border-white/10 pt-3">
                  <summary className="cursor-pointer text-sec">
                    {zh ? '绑定历史' : 'Binding history'} ({view.history.length})
                  </summary>
                  <ol className="mt-3 space-y-3">
                    {view.history.map((item) => (
                      <li key={item.id}>
                        <p className="text-xs text-sec">
                          {zh ? '代次' : 'Generation'} {item.generation} · {item.reason}
                        </p>
                        <p className="mt-1 break-all font-mono text-xs">
                          {item.native_id ??
                            (zh ? '未分配 / 结果不确定' : 'Not allocated / result uncertain')}
                        </p>
                      </li>
                    ))}
                  </ol>
                </details>
              )}
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
