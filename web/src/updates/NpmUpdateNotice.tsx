import { ArrowUpCircle, Check, Copy, X } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { compareSemverVersions } from '../../../src/shared/semver.js'
import { useI18n } from '../i18n.js'
import { useNpmVersionInfo } from './useNpmVersionInfo.js'
import './npm-update.css'

const commands = ['npm install -g hiveteam@latest', 'npx --yes hiveteam@latest'] as const

export const NpmUpdateNotice = ({
  version,
  enabled = true,
}: {
  version: string
  enabled?: boolean
}) => {
  const { t } = useI18n()
  const info = useNpmVersionInfo(enabled)
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const [copyFailed, setCopyFailed] = useState(false)
  const [left, setLeft] = useState(12)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const panelId = useId()
  const titleId = useId()
  const updateAvailable = info !== null && compareSemverVersions(info.latest_version, version) === 1

  useEffect(() => {
    if (!open || !updateAvailable) return
    const position = () => {
      const trigger = triggerRef.current
      if (trigger)
        setLeft(
          Math.max(12, Math.min(trigger.getBoundingClientRect().left, window.innerWidth - 372))
        )
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    const onPointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !triggerRef.current?.contains(event.target) &&
        !panelRef.current?.contains(event.target)
      ) {
        setOpen(false)
      }
    }
    position()
    panelRef.current?.focus()
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('resize', position)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('resize', position)
    }
  }, [open, updateAvailable])

  if (!updateAvailable || !info) return null

  const copyCommand = async (command: string) => {
    setCopied(null)
    setCopyFailed(false)
    if (!navigator.clipboard) {
      setCopyFailed(true)
      return
    }
    try {
      await navigator.clipboard.writeText(command)
      setCopied(command)
    } catch {
      setCopyFailed(true)
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="npm-update-trigger"
        aria-label={t('npmUpdate.upgrade')}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((value) => !value)}
        data-testid="npm-update-notice"
      >
        <ArrowUpCircle size={13} aria-hidden />
        <span className="npm-update-label">{t('npmUpdate.upgrade')}</span>
        <span className="npm-update-label-compact" aria-hidden>
          {t('npmUpdate.upgradeCompact')}
        </span>
      </button>
      {open
        ? createPortal(
            <div
              ref={panelRef}
              id={panelId}
              role="dialog"
              aria-modal="false"
              aria-labelledby={titleId}
              tabIndex={-1}
              className="npm-update-panel"
              style={{ left }}
              data-testid="npm-update-panel"
            >
              <div className="flex items-center justify-between gap-3">
                <h2 id={titleId} className="font-semibold text-pri">
                  {t('npmUpdate.title')}
                </h2>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={t('npmUpdate.close')}
                  onClick={() => {
                    setOpen(false)
                    triggerRef.current?.focus()
                  }}
                >
                  <X size={14} aria-hidden />
                </button>
              </div>
              <p className="mt-2 text-xs text-sec tabular-nums">
                {t('npmUpdate.versions', { current: version, latest: info.latest_version })}
              </p>
              <p className="mt-3 text-sm text-sec">{t('npmUpdate.instructions')}</p>
              {commands.map((command, index) => (
                <div key={command} className="mt-4">
                  <p className="mb-1 text-xs font-medium text-sec">
                    {t(index === 0 ? 'npmUpdate.globalInstall' : 'npmUpdate.runOnce')}
                  </p>
                  <div className="npm-update-command">
                    <code>{command}</code>
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={t('npmUpdate.copyCommand', { command })}
                      onClick={() => void copyCommand(command)}
                    >
                      {copied === command ? (
                        <Check size={14} aria-hidden />
                      ) : (
                        <Copy size={14} aria-hidden />
                      )}
                    </button>
                  </div>
                </div>
              ))}
              <p role="status" className="npm-update-copy-status text-xs text-sec">
                {copyFailed ? t('npmUpdate.copyFailed') : copied ? t('npmUpdate.copied') : ''}
              </p>
            </div>,
            document.body
          )
        : null}
    </>
  )
}
