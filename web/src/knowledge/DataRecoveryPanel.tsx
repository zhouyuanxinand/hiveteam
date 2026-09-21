import { useState } from 'react'
import type { HiveBackupManifest } from '../../../src/shared/data-backup.js'
import { apiFetch } from '../api.js'
import { useI18n } from '../i18n.js'
import { isRemoteMode } from '../remote/remote-permissions-api.js'

interface RetentionPreview {
  version: string
  total: number
  eligible: number
  records: Array<{ dispatch_id: string; archived: boolean; eligible: boolean; reasons: string[] }>
}
interface BackupPreview {
  manifest: HiveBackupManifest
  manifest_version: string
}
const request = async <T,>(path: string, body?: unknown): Promise<T> => {
  const response = await apiFetch(
    path,
    body === undefined
      ? undefined
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }
  )
  const result = await response.json()
  if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`)
  return result as T
}

export const DataRecoveryPanel = ({ workspaceId }: { workspaceId: string }) => {
  const { language } = useI18n(),
    zh = language === 'zh'
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [receipt, setReceipt] = useState('')
  const [retention, setRetention] = useState<RetentionPreview | null>(null)
  const [selected, setSelected] = useState<string[]>([]),
    [confirmed, setConfirmed] = useState(false)
  const [output, setOutput] = useState(''),
    [directory, setDirectory] = useState(''),
    [target, setTarget] = useState('')
  const [preview, setPreview] = useState<BackupPreview | null>(null),
    [bindings, setBindings] = useState<Record<string, string>>({})
  const [restoreConfirmed, setRestoreConfirmed] = useState(false)
  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError('')
    setReceipt('')
    try {
      await action()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  const retentionPath = `/api/ui/workspaces/${workspaceId}/retention`
  const refresh = async () => {
    setRetention(await request<RetentionPreview>(retentionPath))
    setSelected([])
    setConfirmed(false)
  }
  if (isRemoteMode()) return null
  return (
    <details className="memory-context-panel">
      <summary>{zh ? '本地备份、恢复与归档' : 'Local backup, restore and archive'}</summary>
      <p>
        {zh
          ? '备份包含 Hive 记录和托管附件。项目文件与外部 worktree 需另行备份；自然语言内容仍可能敏感。'
          : 'Backups include Hive records and managed attachments. Back up projects and external worktrees separately; text may contain sensitive data.'}
      </p>
      <fieldset disabled={busy}>
        <legend>{zh ? '创建备份' : 'Create backup'}</legend>
        <label>
          {zh ? '新备份目录' : 'New backup directory'}
          <input value={output} onChange={(e) => setOutput(e.target.value)} />
        </label>
        <button
          type="button"
          className="icon-btn"
          disabled={!output.trim()}
          onClick={() =>
            void run(async () => {
              const result = await request<{ path: string }>('/api/settings/backups', { output })
              setReceipt(`${zh ? '备份已保存' : 'Backup saved'}: ${result.path}`)
            })
          }
        >
          {zh ? '创建备份' : 'Create backup'}
        </button>
      </fieldset>
      <fieldset disabled={busy}>
        <legend>{zh ? '恢复到新数据目录' : 'Restore to a new data directory'}</legend>
        <label>
          {zh ? '备份目录' : 'Backup directory'}
          <input
            value={directory}
            onChange={(e) => {
              setDirectory(e.target.value)
              setPreview(null)
              setRestoreConfirmed(false)
            }}
          />
        </label>
        <button
          type="button"
          className="icon-btn"
          disabled={!directory.trim()}
          onClick={() =>
            void run(async () => {
              const result = await request<BackupPreview>('/api/settings/backups/inspect', {
                directory,
              })
              setPreview(result)
              setBindings({})
              setRestoreConfirmed(false)
            })
          }
        >
          {zh ? '校验并预览' : 'Validate and preview'}
        </button>
        {preview && (
          <>
            <p>
              {preview.manifest.app_version} · {preview.manifest.platform}/
              {preview.manifest.architecture} · {preview.manifest.attachments.length}{' '}
              {zh ? '个附件' : 'attachments'}
            </p>
            <p>
              {zh
                ? 'CLI 需重新配置，远程设备需重新配对，原生会话需重新绑定；所有 agent 保持停止。'
                : 'CLI configuration, devices and native sessions require rebinding. All agents remain stopped.'}
            </p>
            {preview.manifest.workspaces.map((workspace) => (
              <label key={workspace.id}>
                {workspace.name} · {workspace.path}
                <input
                  aria-label={`${zh ? '新项目路径' : 'New project path'}: ${workspace.name}`}
                  value={bindings[workspace.id] ?? ''}
                  onChange={(e) => {
                    setBindings({ ...bindings, [workspace.id]: e.target.value })
                    setRestoreConfirmed(false)
                  }}
                />
              </label>
            ))}
            <label>
              {zh ? '新数据目录' : 'New data directory'}
              <input
                value={target}
                onChange={(e) => {
                  setTarget(e.target.value)
                  setRestoreConfirmed(false)
                }}
              />
            </label>
            <label>
              <input
                type="checkbox"
                checked={restoreConfirmed}
                onChange={(e) => setRestoreConfirmed(e.target.checked)}
              />
              {zh
                ? '已核对目标与路径绑定；旧数据保留。'
                : 'I reviewed the target and path bindings; existing data is retained.'}
            </label>
            <button
              type="button"
              className="icon-btn"
              disabled={
                !restoreConfirmed ||
                !target.trim() ||
                preview.manifest.workspaces.some((w) => !bindings[w.id]?.trim())
              }
              onClick={() =>
                void run(async () => {
                  const result = await request<{ target: string }>(
                    '/api/settings/backups/restore',
                    {
                      directory,
                      target,
                      manifest_version: preview.manifest_version,
                      workspace_bindings: bindings,
                      confirm: true,
                    }
                  )
                  setRestoreConfirmed(false)
                  setReceipt(
                    `${zh ? '恢复目录已准备；退出 Hive 后以 HIVE_DATA_DIR 指向此目录重新启动' : 'Restored directory is ready; exit Hive and restart with HIVE_DATA_DIR pointing here'}: ${result.target}`
                  )
                })
              }
            >
              {zh ? '确认恢复到新目录' : 'Confirm restore to new directory'}
            </button>
          </>
        )}
      </fieldset>
      <fieldset disabled={busy}>
        <legend>{zh ? '派单归档' : 'Dispatch archive'}</legend>
        <p>
          {zh
            ? '归档仅隐藏已确认记录，文件与证据保留，释放空间为 0。可随时取消归档。'
            : 'Archive hides confirmed records; files and evidence are retained. Space reclaimed: 0. Archiving is reversible.'}
        </p>
        <button type="button" className="icon-btn" onClick={() => void run(refresh)}>
          {zh ? '预览归档范围' : 'Preview archive scope'}
        </button>
        {retention && (
          <>
            <p>
              {retention.total} {zh ? '条记录，可归档' : 'records; eligible'} {retention.eligible}
            </p>
            <div className="retention-records">
              {retention.records.map((record) => (
                <label key={record.dispatch_id}>
                  <input
                    type="checkbox"
                    disabled={!record.eligible && !record.archived}
                    checked={selected.includes(record.dispatch_id)}
                    onChange={(e) => {
                      setSelected(
                        e.target.checked
                          ? [...selected, record.dispatch_id]
                          : selected.filter((id) => id !== record.dispatch_id)
                      )
                      setConfirmed(false)
                    }}
                  />
                  <code>{record.dispatch_id}</code> ·{' '}
                  {record.archived
                    ? zh
                      ? '已归档'
                      : 'archived'
                    : record.reasons.join(', ') || (zh ? '可归档' : 'eligible')}
                </label>
              ))}
            </div>
            <label>
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              {zh ? '确认处理选中的记录' : 'Confirm changes to selected records'}
            </label>
            {(['archive', 'restore'] as const).map((action) => (
              <button
                type="button"
                className="icon-btn"
                key={action}
                disabled={
                  !confirmed ||
                  !selected.length ||
                  selected.some((id) => {
                    const row = retention.records.find((r) => r.dispatch_id === id)
                    return action === 'archive' ? !row?.eligible : !row?.archived
                  })
                }
                onClick={() =>
                  void run(async () => {
                    await request(retentionPath, {
                      operation_id: crypto.randomUUID(),
                      expected_version: retention.version,
                      dispatch_ids: selected,
                      action,
                      confirm: true,
                    })
                    await refresh()
                    setReceipt(
                      zh
                        ? '归档状态已更新；文件未删除。'
                        : 'Archive state updated; no files deleted.'
                    )
                  })
                }
              >
                {action === 'archive'
                  ? zh
                    ? '归档所选'
                    : 'Archive selected'
                  : zh
                    ? '取消归档'
                    : 'Unarchive selected'}
              </button>
            ))}
          </>
        )}
      </fieldset>
      {error && <p role="alert">{error}</p>}
      {receipt && <p role="status">{receipt}</p>}
    </details>
  )
}
