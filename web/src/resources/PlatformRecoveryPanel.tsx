import { useEffect, useState } from 'react'
import type { PlatformRecoveryView } from '../../../src/shared/platform-recovery.js'
import { apiFetch, readErrorMessage } from '../api.js'
import { useI18n } from '../i18n.js'
import { isRemoteMode } from '../remote/remote-permissions-api.js'

const stateLabels = {
  starting: ['正在启动', 'Starting'],
  running: ['运行中', 'Running'],
  restarting: ['正在恢复', 'Restarting'],
  stopping: ['正在停止', 'Stopping'],
  stopped: ['已停止', 'Stopped'],
  failed: ['恢复失败', 'Recovery failed'],
} as const

export const PlatformRecoveryPanel = () => {
  const { language } = useI18n()
  const zh = language === 'zh'
  const remote = isRemoteMode()
  const [view, setView] = useState<PlatformRecoveryView | null>(null)
  const [readError, setReadError] = useState('')
  const [writeError, setWriteError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (remote || busy) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const controller = new AbortController()
    const read = async () => {
      try {
        const response = await apiFetch('/api/ui/platform/recovery', {
          cache: 'no-store',
          signal: controller.signal,
        })
        if (!response.ok)
          throw new Error(
            await readErrorMessage(
              response,
              zh ? '无法读取平台恢复状态' : 'Unable to read platform recovery'
            )
          )
        const next = (await response.json()) as PlatformRecoveryView
        if (!disposed) {
          setView(next)
          setReadError('')
        }
      } catch (error) {
        if (!disposed) setReadError(error instanceof Error ? error.message : String(error))
      } finally {
        if (!disposed) timer = setTimeout(() => void read(), 15_000)
      }
    }
    void read()
    return () => {
      disposed = true
      controller.abort()
      clearTimeout(timer)
    }
  }, [remote, busy, zh])
  if (remote) return null
  const update = async (enabled: boolean) => {
    setBusy(true)
    setWriteError('')
    try {
      const response = await apiFetch('/api/ui/platform/recovery/autostart', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled }),
      })
      if (!response.ok)
        throw new Error(
          await readErrorMessage(
            response,
            zh ? '无法更改登录自启动设置' : 'Unable to change sign-in startup'
          )
        )
      setView((await response.json()) as PlatformRecoveryView)
    } catch (error) {
      setWriteError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section
      aria-label={zh ? '平台恢复' : 'Platform recovery'}
      className="mt-5 border-t pt-4"
      style={{ borderColor: 'var(--border)' }}
    >
      <h3 className="text-sm font-semibold text-pri">{zh ? '平台恢复' : 'Platform recovery'}</h3>
      {(readError || writeError) && (
        <p role="alert" className="mt-2 text-sm text-red-400">
          {writeError || readError}
        </p>
      )}
      {!view && !readError && (
        <p role="status" className="mt-2 text-xs text-sec">
          {zh ? '正在读取平台状态…' : 'Loading platform status…'}
        </p>
      )}
      {view && (
        <>
          <p className="mt-2 text-sm text-pri">
            {view.managed
              ? zh
                ? '守护已启用'
                : 'Supervision enabled'
              : zh
                ? '未托管'
                : 'Not supervised'}
          </p>
          <p className="mt-1 text-xs text-sec">
            {view.managed
              ? zh
                ? '平台进程意外退出后会自动恢复。退出平台后不会立即重启。'
                : 'Platform processes recover after an unexpected exit. Exiting the platform stops automatic recovery.'
              : zh
                ? '当前实例未通过平台守护启动。下次使用平台启动器可启用意外退出恢复。'
                : 'This instance was started without supervision. Use the platform launcher next time to recover unexpected exits.'}
          </p>
          {view.supervision && (
            <>
              <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs text-sec">
                <dt>{zh ? '守护状态' : 'Supervisor state'}</dt>
                <dd>{stateLabels[view.supervision.state][zh ? 0 : 1]}</dd>
                <dt>{zh ? '连续重试次数' : 'Consecutive retries'}</dt>
                <dd>{view.supervision.restart_count}</dd>
              </dl>
              {view.supervision.last_error && (
                <p role="alert" className="mt-2 break-words text-xs text-red-400">
                  {view.supervision.last_error}
                </p>
              )}
            </>
          )}
          {view.auto_start.error ? (
            <p className="mt-4 text-sm text-sec">
              {zh
                ? '无法确认登录自启动状态，恢复查询后再修改。'
                : 'Sign-in startup status is unknown. Wait for a successful refresh before changing it.'}
            </p>
          ) : (
            <>
              <label className="mt-4 flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  role="switch"
                  aria-checked={view.auto_start.enabled}
                  checked={view.auto_start.enabled}
                  disabled={busy || !view.auto_start.supported}
                  onChange={(event) => void update(event.target.checked)}
                />
                {zh ? '登录系统时自动启动 HiveTeam' : 'Start HiveTeam when I sign in'}
              </label>
              <p className="mt-1 text-xs text-sec">
                {zh
                  ? '开关在下次登录时生效，当前平台继续运行。'
                  : 'This setting takes effect at your next sign-in. The current platform keeps running.'}
              </p>
            </>
          )}
          {busy && (
            <p role="status" className="mt-1 text-xs text-sec">
              {zh ? '正在保存自启动设置…' : 'Saving sign-in startup…'}
            </p>
          )}
          {!view.auto_start.supported && (
            <p className="mt-1 text-xs text-sec">
              {!view.managed
                ? zh
                  ? '通过平台启动器启动后可配置登录自启动。'
                  : 'Use the platform launcher to configure sign-in startup.'
                : zh
                  ? '当前系统不支持登录自启动。'
                  : 'Sign-in startup is not supported on this system.'}
            </p>
          )}
          {view.auto_start.error && (
            <p role="alert" className="mt-2 break-words text-xs text-red-400">
              {view.auto_start.error}
            </p>
          )}
        </>
      )}
    </section>
  )
}
