import * as Dialog from '@radix-ui/react-dialog'
import { ShieldCheck, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type {
  ExecutionPermissions,
  ExecutionPolicyView,
} from '../../../src/shared/execution-policy.js'
import { useI18n } from '../i18n.js'
import { isRemoteMode } from '../remote/remote-permissions-api.js'
import { AutomaticWorkerTrustPreference } from './AutomaticWorkerTrustPreference.js'
import { executionPolicyRequest } from './execution-policy-api.js'
import { executionCapabilityMessage } from './execution-policy-labels.js'

const PermissionDetails = ({
  permissions,
  zh,
}: {
  permissions: ExecutionPermissions
  zh: boolean
}) => (
  <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-xs">
    <dt className="text-ter">{zh ? '读取路径' : 'Read roots'}</dt>
    <dd className="break-all text-sec">{permissions.read_roots.join('\n') || '—'}</dd>
    <dt className="text-ter">{zh ? '写入路径' : 'Write roots'}</dt>
    <dd className="break-all text-sec">{permissions.write_roots.join('\n') || '—'}</dd>
    {permissions.deny_roots?.length ? (
      <>
        <dt className="text-ter">{zh ? '禁止访问' : 'Denied paths'}</dt>
        <dd className="break-all text-sec">{permissions.deny_roots.join('\n')}</dd>
      </>
    ) : null}
    <dt className="text-ter">{zh ? '工具网络' : 'Tool network'}</dt>
    <dd className="text-sec">
      {permissions.network === 'none' ? (zh ? '禁止' : 'Denied') : zh ? '不限制' : 'Unrestricted'}
    </dd>
    <dt className="text-ter">{zh ? '认证边界' : 'Credential boundary'}</dt>
    <dd className="text-sec">
      {permissions.credentials === 'isolated_cli_home'
        ? zh
          ? '独立 CLI 配置目录'
          : 'Isolated CLI home'
        : zh
          ? '信任 CLI 及其配置'
          : 'Trusted CLI and its configuration'}
    </dd>
    <dt className="text-ter">Git</dt>
    <dd className="text-sec">{permissions.git_operations.join(', ') || '—'}</dd>
    <dt className="text-ter">{zh ? 'CLI 审批' : 'CLI approvals'}</dt>
    <dd className="text-sec">
      {permissions.approval === 'never'
        ? zh
          ? '不交互；越界直接拒绝'
          : 'Non-interactive; deny out-of-scope actions'
        : zh
          ? '由 CLI 配置决定'
          : 'Defined by CLI configuration'}
    </dd>
  </dl>
)

export const ExecutionPolicyButton = ({
  workspaceId,
  agentId,
  running = false,
  triggerLabel,
  onAuthorized,
}: {
  workspaceId: string
  agentId: string
  running?: boolean
  triggerLabel?: string
  onAuthorized?: () => void
}) => {
  const { language } = useI18n()
  const zh = language === 'zh'
  const [open, setOpen] = useState(false)
  const [policy, setPolicy] = useState<ExecutionPolicyView | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)
  const [trustAutomaticWorkers, setTrustAutomaticWorkers] = useState(false)
  const requestEpoch = useRef(0)
  useEffect(() => {
    const epoch = ++requestEpoch.current
    setBusy(false)
    if (!open) return
    setPolicy(null)
    setError('')
    setAcknowledged(false)
    setTrustAutomaticWorkers(false)
    void executionPolicyRequest(workspaceId, agentId).then(
      (view) => {
        if (requestEpoch.current === epoch) {
          setPolicy(view)
          setAcknowledged(view.automatic_worker === true)
          setTrustAutomaticWorkers(
            view.trust_automatic_workers === true ||
              (view.automatic_worker === true &&
                view.automatic_worker_trust_configured === false &&
                view.enforcement !== 'trusted_unsafe')
          )
        }
      },
      (cause: unknown) => {
        if (requestEpoch.current === epoch)
          setError(cause instanceof Error ? cause.message : 'Unable to load execution policy')
      }
    )
    return () => {
      requestEpoch.current++
    }
  }, [open, workspaceId, agentId])
  if (isRemoteMode()) return null
  const update = async (unsafe: boolean, defaultOnly = false) => {
    if (!policy || busy || (unsafe && !defaultOnly && !acknowledged)) return
    const epoch = requestEpoch.current
    setBusy(true)
    setError('')
    try {
      const updated = await executionPolicyRequest(
        workspaceId,
        agentId,
        unsafe ? 'PUT' : 'DELETE',
        unsafe
          ? {
              profile: defaultOnly ? policy.profile : 'trusted_unsafe',
              expected_cli_fingerprint: policy.cli_fingerprint,
              expected_cli_version: policy.cli_version,
              policy_revision: policy.policy_revision,
              acknowledge_unsafe: true,
              ...(defaultOnly || trustAutomaticWorkers !== (policy.trust_automatic_workers === true)
                ? { trust_automatic_workers: trustAutomaticWorkers }
                : {}),
            }
          : undefined
      )
      if (requestEpoch.current !== epoch) return
      setPolicy(updated)
      setAcknowledged(false)
      setTrustAutomaticWorkers(updated.trust_automatic_workers === true)
      if (unsafe && !defaultOnly && updated.enforcement === 'trusted_unsafe' && onAuthorized) {
        setOpen(false)
        onAuthorized()
      }
    } catch (cause) {
      if (requestEpoch.current === epoch)
        setError(cause instanceof Error ? cause.message : 'Unable to update execution policy')
    } finally {
      if (requestEpoch.current === epoch) setBusy(false)
    }
  }
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) requestEpoch.current++
        setOpen(nextOpen)
      }}
    >
      <Dialog.Trigger asChild>
        <button
          type="button"
          className={onAuthorized ? 'icon-btn icon-btn--primary text-xs' : 'icon-btn text-xs'}
          aria-label={triggerLabel ?? (zh ? '执行权限' : 'Execution permissions')}
        >
          <ShieldCheck size={13} aria-hidden />
          {triggerLabel ?? (zh ? '执行权限' : 'Permissions')}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="app-overlay fixed inset-0 z-[60]" />
        <div className="pointer-events-none fixed inset-0 z-[61] grid place-items-center p-4">
          <Dialog.Content
            className="pointer-events-auto min-w-0 max-h-[85vh] overflow-y-auto rounded-lg border p-5 [overflow-wrap:anywhere]"
            style={{
              width: 'min(580px, calc(100vw - 2rem))',
              background: 'var(--bg-elevated)',
              borderColor: 'var(--border)',
            }}
          >
            <div className="flex items-center justify-between gap-3">
              <Dialog.Title className="font-semibold text-pri">
                {zh ? '执行权限' : 'Execution permissions'}
              </Dialog.Title>
              <Dialog.Close asChild>
                <button type="button" className="icon-btn" aria-label={zh ? '关闭' : 'Close'}>
                  <X size={16} />
                </button>
              </Dialog.Close>
            </div>
            <Dialog.Description className="my-3 text-sm text-sec">
              {zh
                ? '配置只在下次启动或恢复时重新校验。工作树和角色名称本身不能证明已隔离。'
                : 'Changes are revalidated on the next start or resume. A worktree or role name alone does not establish isolation.'}
            </Dialog.Description>
            {error ? (
              <p role="alert" className="my-3 text-sm text-red-400">
                {error}
              </p>
            ) : null}
            {running ? (
              <p className="my-3 text-sm text-sec">
                {zh
                  ? '该成员正在运行。改变下次启动策略不会收回当前进程已有权限；需要停止后重新启动。'
                  : 'This agent is running. Changing the next launch policy does not remove permissions from its current process. Stop and restart to apply it.'}
              </p>
            ) : null}
            {policy ? (
              <>
                {policy.active_policy ? (
                  <div
                    className="my-3 rounded border p-3"
                    style={{
                      borderColor:
                        policy.active_policy.enforcement === 'enforced'
                          ? 'var(--status-green)'
                          : 'var(--status-orange)',
                    }}
                  >
                    <p className="text-sm font-medium text-pri">
                      {policy.active_policy.enforcement === 'enforced'
                        ? zh
                          ? '当前进程：强制受限'
                          : 'Current process: enforced restrictions'
                        : zh
                          ? '当前进程：无隔离例外'
                          : 'Current process: unsafe exception'}
                    </p>
                    <p className="mt-1 text-xs text-ter">
                      {zh ? '策略版本' : 'Policy revision'} {policy.active_policy.policy_revision} ·
                      CLI {policy.active_policy.cli_version ?? '?'}
                    </p>
                    {policy.active_policy.checkout_head_sha ? (
                      <p className="mt-2 break-all text-xs text-sec">
                        {zh ? '测试版本' : 'Tested commit'}:{' '}
                        <code>{policy.active_policy.checkout_head_sha}</code>
                      </p>
                    ) : null}
                    {policy.active_policy.actual ? (
                      <PermissionDetails permissions={policy.active_policy.actual} zh={zh} />
                    ) : null}
                  </div>
                ) : policy.active_run_unverified ? (
                  <p
                    role="status"
                    className="my-3 text-sm"
                    style={{ color: 'var(--status-orange)' }}
                  >
                    {zh
                      ? '当前进程没有可验证的启动策略快照，不能确认隔离。'
                      : 'Current process has no verifiable launch-policy snapshot; isolation is unconfirmed.'}
                  </p>
                ) : null}
                <p className="text-sm font-medium text-pri">
                  {policy.cli_id} {policy.cli_version ?? (zh ? '版本未确认' : 'Unknown version')} ·{' '}
                  {policy.platform} · {policy.role}
                </p>
                <p
                  className="mt-2 text-sm"
                  style={{
                    color:
                      policy.enforcement === 'enforced'
                        ? 'var(--status-green)'
                        : 'var(--status-orange)',
                  }}
                >
                  {policy.enforcement === 'enforced'
                    ? zh
                      ? '下次启动：受限；通过本机沙箱检查后启动'
                      : 'Next launch: restricted; requires a successful local sandbox check'
                    : policy.enforcement === 'pending'
                      ? zh
                        ? '下次启动：先验证本机沙箱，通过后以受限权限运行'
                        : 'Next launch: verify the local sandbox before running with restrictions'
                      : policy.enforcement === 'trusted_unsafe'
                        ? zh
                          ? '下次启动：已授权无隔离例外'
                          : 'Next launch: authorized unsafe exception'
                        : zh
                          ? '下次启动：能力不满足，将拒绝启动'
                          : 'Next launch: unsupported, start will be rejected'}
                </p>
                {policy.missing_capabilities.length ? (
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-sec">
                    {policy.missing_capabilities.map((item) => (
                      <li key={item}>{executionCapabilityMessage(item, zh)}</li>
                    ))}
                  </ul>
                ) : null}
                {policy.warnings.map((warning) => (
                  <p key={warning} className="mt-2 text-xs text-sec">
                    {warning}
                  </p>
                ))}
                <details className="my-3">
                  <summary className="cursor-pointer text-sm text-pri">
                    {zh ? '请求的访问范围' : 'Requested access'}
                  </summary>
                  <PermissionDetails permissions={policy.requested} zh={zh} />
                </details>
                {policy.actual ? (
                  <details className="my-3">
                    <summary className="cursor-pointer text-sm text-pri">
                      {zh ? '下次启动的计划访问范围' : 'Planned access for next launch'}
                    </summary>
                    <PermissionDetails permissions={policy.actual} zh={zh} />
                  </details>
                ) : null}
                {policy.automatic_worker || policy.automatic_worker_trust_configured ? (
                  <AutomaticWorkerTrustPreference
                    checked={trustAutomaticWorkers}
                    disabled={busy}
                    saved={policy.trust_automatic_workers === true}
                    zh={zh}
                    onChange={setTrustAutomaticWorkers}
                    {...(policy.enforcement === 'trusted_unsafe' ||
                    policy.automatic_worker_trust_configured
                      ? { onSave: () => void update(true, true) }
                      : {})}
                  />
                ) : null}
                {policy.enforcement === 'trusted_unsafe' ? (
                  <div
                    className="mt-4 rounded border p-3"
                    style={{ borderColor: 'var(--status-orange)' }}
                  >
                    <p className="text-xs text-sec">
                      {zh
                        ? '例外仅绑定此工作区、成员、CLI 文件指纹及版本、策略版本。CLI 升级后须重新确认。'
                        : 'Exception is bound to this workspace, agent, CLI fingerprint and version, and policy revision. CLI upgrades require a new confirmation.'}
                    </p>
                    {onAuthorized ? (
                      <button
                        type="button"
                        className="icon-btn icon-btn--primary mt-3"
                        disabled={busy || running}
                        onClick={() => {
                          setOpen(false)
                          onAuthorized()
                        }}
                      >
                        {zh ? '使用已授权权限重试启动' : 'Retry with authorized permissions'}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="icon-btn icon-btn--danger mt-3"
                      disabled={busy}
                      onClick={() => void update(false)}
                    >
                      {zh
                        ? '撤销例外，恢复受限默认值'
                        : 'Revoke exception and restore restricted defaults'}
                    </button>
                  </div>
                ) : (
                  <div className="mt-4 rounded border p-3" style={{ borderColor: 'var(--border)' }}>
                    <label className="flex items-start gap-2 text-sm text-sec">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={acknowledged}
                        disabled={busy}
                        onChange={(event) => setAcknowledged(event.target.checked)}
                      />
                      {zh
                        ? '我信任这个 CLI，允许此成员不受 HiveTeam 文件、网络和 Git 隔离限制。它可能使用当前系统账户能访问的文件与凭据。'
                        : 'I trust this CLI and allow this agent to run without HiveTeam file, network, or Git isolation. It may access files and credentials available to my system account.'}
                    </label>
                    <button
                      type="button"
                      className="icon-btn icon-btn--danger mt-3"
                      disabled={!acknowledged || busy}
                      onClick={() => void update(true)}
                    >
                      {onAuthorized
                        ? zh
                          ? '授权并重试启动'
                          : 'Authorize and retry launch'
                        : zh
                          ? '为此成员授权无隔离例外'
                          : 'Authorize unsafe exception for this agent'}
                    </button>
                  </div>
                )}
              </>
            ) : !error ? (
              <p role="status" className="text-sm text-sec">
                {zh ? '正在检查启动能力…' : 'Checking launch capabilities…'}
              </p>
            ) : null}
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
