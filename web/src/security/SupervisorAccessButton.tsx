import * as Dialog from '@radix-ui/react-dialog'
import { KeyRound, X } from 'lucide-react'
import { useState } from 'react'

import { apiFetch, readErrorMessage } from '../api.js'
import { useI18n } from '../i18n.js'

export const SupervisorAccessButton = () => {
  const { language } = useI18n()
  const zh = language === 'zh'
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  if ((window as Window & { __HIVE_REMOTE_MODE__?: boolean }).__HIVE_REMOTE_MODE__) return null

  const copyConfiguration = async () => {
    setBusy(true)
    setMessage('')
    try {
      if (!navigator.clipboard) {
        throw new Error(
          zh
            ? '浏览器不支持剪贴板，请使用桌面浏览器。'
            : 'Use a desktop browser with clipboard access.'
        )
      }
      const response = await apiFetch('/api/external-goals/session')
      if (!response.ok) throw new Error(await readErrorMessage(response, 'Authorization failed'))
      const capability = (await response.json()) as { token: string; runtime_base_url: string }
      await navigator.clipboard.writeText(
        JSON.stringify(
          {
            command: 'hive',
            args: ['mcp', '--base-url', capability.runtime_base_url],
            env: { HIVE_SUPERVISOR_TOKEN: capability.token },
          },
          null,
          2
        )
      )
      setMessage(
        zh
          ? '配置已复制。HiveTeam 重启后请重新获取。'
          : 'Configuration copied. Get a new capability after restarting HiveTeam.'
      )
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Authorization failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(value) => {
        setOpen(value)
        setMessage('')
      }}
    >
      <Dialog.Trigger asChild>
        <button
          type="button"
          className="topbar-knowledge-button"
          aria-label={zh ? '授权 MCP 控制端' : 'Authorize MCP controller'}
        >
          <KeyRound size={13} aria-hidden />
          <span>MCP</span>
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="app-overlay fixed inset-0 z-40" />
        <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center p-4">
          <Dialog.Content
            className="pointer-events-auto w-[440px] max-w-full rounded-lg border p-5"
            style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)' }}
          >
            <div className="flex items-center justify-between gap-3">
              <Dialog.Title className="font-semibold text-pri">
                {zh ? '授权 MCP 控制端' : 'Authorize MCP controller'}
              </Dialog.Title>
              <Dialog.Close asChild>
                <button type="button" className="icon-btn" aria-label={zh ? '关闭' : 'Close'}>
                  <X size={16} />
                </button>
              </Dialog.Close>
            </div>
            <Dialog.Description className="mt-3 text-sm text-sec">
              {zh
                ? '复制的配置允许受信任的 MCP 客户端查看工作区、派发和取消目标。仅放入你选择的客户端配置；授权在 HiveTeam 重启时失效。'
                : 'The copied configuration lets your trusted MCP client inspect workspaces, start goals, and cancel goals. Add it only to your chosen client. Authorization expires when HiveTeam restarts.'}
            </Dialog.Description>
            <button
              type="button"
              className="btn-primary mt-4"
              disabled={busy}
              onClick={() => void copyConfiguration()}
            >
              {zh ? '复制授权配置' : 'Copy authorized configuration'}
            </button>
            {message ? (
              <p role="status" className="mt-3 text-sm text-sec">
                {message}
              </p>
            ) : null}
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
