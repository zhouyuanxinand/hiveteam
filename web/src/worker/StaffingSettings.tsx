import { useEffect, useState } from 'react'
import type { TeamListItemPayload } from '../../../src/shared/types.js'
import type { StaffingPolicy } from '../../../src/shared/worker-lifecycle.js'
import { type CommandPreset, listCommandPresets } from '../api.js'
import { useI18n } from '../i18n.js'
import { readRetiredMembers, readStaffingPolicy, saveStaffingPolicy } from './staffing-api.js'

export const StaffingSettings = ({ workspaceId }: { workspaceId: string }) => {
  const { language } = useI18n()
  const zh = language === 'zh'
  const [open, setOpen] = useState(false)
  const [policy, setPolicy] = useState<StaffingPolicy | null>(null)
  const [presets, setPresets] = useState<Array<Pick<CommandPreset, 'id' | 'displayName'>>>([])
  const [retired, setRetired] = useState<TeamListItemPayload[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [revision, setRevision] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision explicitly retries a failed load.
  useEffect(() => {
    if (!open) return
    let disposed = false
    setPolicy(null)
    setError('')
    setSaved(false)
    void Promise.all([
      readStaffingPolicy(workspaceId),
      listCommandPresets(),
      readRetiredMembers(workspaceId),
    ]).then(
      ([value, commands, history]) => {
        if (disposed) return
        setPolicy(value)
        setPresets([
          ...commands,
          ...value.allowed_command_preset_ids
            .filter((id) => !commands.some((command) => command.id === id))
            .map((id) => ({ id, displayName: `${id} (${zh ? '预设已移除' : 'preset removed'})` })),
        ])
        setRetired(history)
      },
      (cause) => {
        if (!disposed) setError(cause instanceof Error ? cause.message : String(cause))
      }
    )
    return () => {
      disposed = true
    }
  }, [workspaceId, open, revision, zh])
  return (
    <details
      className="mx-2 mb-3 text-sm"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer py-2 font-medium text-pri">
        {zh ? '动态配员与退役记录' : 'Dynamic staffing and retired members'}
      </summary>
      <p className="my-3 text-sec">
        {zh
          ? '允许 Orchestrator 按需创建临时成员。仅本机用户可修改授权；关闭后，现有成员可继续完成任务。'
          : 'Allow the Orchestrator to create temporary members. Only the desktop user can change authorization. Disabling this leaves existing members available to finish their tasks.'}
      </p>
      {error ? (
        <div role="alert" className="my-3 text-pri">
          <p className="break-words">{error}</p>
          {!policy ? (
            <button
              type="button"
              className="icon-btn mt-2"
              onClick={() => setRevision((value) => value + 1)}
            >
              {zh ? '重试加载' : 'Retry loading'}
            </button>
          ) : null}
        </div>
      ) : null}
      {!policy && !error ? (
        <p role="status" className="text-sec">
          {zh ? '加载设置…' : 'Loading settings…'}
        </p>
      ) : null}
      {policy ? (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault()
            setBusy(true)
            setError('')
            setSaved(false)
            void saveStaffingPolicy(workspaceId, policy)
              .then(
                (value) => {
                  setPolicy(value)
                  setSaved(true)
                },
                (cause) => setError(cause instanceof Error ? cause.message : String(cause))
              )
              .finally(() => setBusy(false))
          }}
        >
          <fieldset disabled={busy} className="space-y-3" onChange={() => setSaved(false)}>
            <label className="flex items-center gap-2 text-pri">
              <input
                type="checkbox"
                checked={policy.enabled}
                onChange={(event) => setPolicy({ ...policy, enabled: event.target.checked })}
              />
              {zh ? '允许动态创建成员' : 'Allow dynamic members'}
            </label>
            <fieldset className="space-y-2">
              <legend className="mb-2 text-pri">
                {zh ? '允许使用的 CLI 预设' : 'Allowed CLI presets'}
              </legend>
              {presets.map((preset) => (
                <label key={preset.id} className="flex min-w-0 items-start gap-2 text-sec">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={policy.allowed_command_preset_ids.includes(preset.id)}
                    onChange={(event) =>
                      setPolicy({
                        ...policy,
                        allowed_command_preset_ids: event.target.checked
                          ? [...policy.allowed_command_preset_ids, preset.id]
                          : policy.allowed_command_preset_ids.filter((id) => id !== preset.id),
                      })
                    }
                  />
                  <span className="break-words">{preset.displayName}</span>
                </label>
              ))}
              {!presets.length ? (
                <p className="text-sec">
                  {zh ? '请先在设置中添加 CLI 预设。' : 'Add a CLI preset in settings first.'}
                </p>
              ) : null}
            </fieldset>
            <label className="block text-pri">
              {zh ? '最多保留的临时成员数' : 'Maximum temporary members'}
              <input
                type="number"
                min={1}
                max={20}
                step={1}
                required
                className="input mt-1 block w-full text-base"
                value={
                  Number.isNaN(policy.max_ephemeral_workers) ? '' : policy.max_ephemeral_workers
                }
                onChange={(event) =>
                  setPolicy({ ...policy, max_ephemeral_workers: event.target.valueAsNumber })
                }
              />
            </label>
            <p className="text-sec">
              {zh
                ? '停止进程仍占名额；完成或取消任务后退役才会释放名额。退役保留报告、技能和工作目录。'
                : 'Stopped members still count. Dismiss after reporting or cancelling tasks to free a slot. Reports, skills and working directories are retained.'}
            </p>
            <button
              type="submit"
              className="icon-btn icon-btn--primary"
              disabled={policy.enabled && policy.allowed_command_preset_ids.length === 0}
            >
              {busy ? (zh ? '保存中…' : 'Saving…') : zh ? '保存配员设置' : 'Save staffing settings'}
            </button>
          </fieldset>
          {saved ? (
            <p role="status" className="text-sec">
              {zh ? '配员设置已保存。' : 'Staffing settings saved.'}
            </p>
          ) : null}
          <div className="pt-3">
            <h3 className="mb-2 font-medium text-pri">{zh ? '已退役成员' : 'Retired members'}</h3>
            {!retired.length ? (
              <p className="text-sec">{zh ? '暂无退役成员。' : 'No retired members yet.'}</p>
            ) : (
              <ul className="space-y-2">
                {retired.map((worker) => (
                  <li key={worker.id}>
                    <details>
                      <summary className="cursor-pointer break-words py-1 text-pri">
                        {worker.name} · {worker.role}
                      </summary>
                      <dl className="mt-2 space-y-1 break-all text-sec">
                        <dt>{zh ? '成员 ID' : 'Member ID'}</dt>
                        <dd className="mono">{worker.id}</dd>
                        {worker.working_directory ? (
                          <>
                            <dt>{zh ? '保留的工作目录' : 'Retained working directory'}</dt>
                            <dd>{worker.working_directory}</dd>
                          </>
                        ) : null}
                        <dt>{zh ? '退役时间' : 'Retired at'}</dt>
                        <dd>
                          {worker.retired_at === undefined
                            ? ''
                            : new Date(worker.retired_at).toLocaleString(language)}
                        </dd>
                      </dl>
                    </details>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </form>
      ) : null}
    </details>
  )
}
