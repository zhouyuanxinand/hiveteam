import {
  Check,
  Clipboard,
  Cloud,
  Copy,
  ExternalLink,
  Globe2,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Unplug,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import {
  beginRemotePairing,
  confirmRemotePairing,
  getRemoteAudit,
  getRemoteStatus,
  listRemoteDevices,
  listRemotePairings,
  type RemoteAuditRecord,
  type RemoteConnectionStatus,
  type RemoteDevice,
  type RemotePairingTicket,
  type RemotePendingPairing,
  type RemoteStatus,
  rejectRemotePairing,
  revokeRemoteDevice,
  setRemoteEnabled,
} from '../api.js'
import type { TranslationKey } from '../i18n.js'
import { useI18n } from '../i18n.js'
import { Confirm } from '../ui/Confirm.js'
import { Tooltip } from '../ui/Tooltip.js'

const statusColor = (status: RemoteConnectionStatus, enabled: boolean) => {
  if (!enabled || status === 'disabled') return 'var(--text-tertiary)'
  if (status === 'online') return 'var(--status-green)'
  if (status === 'revoked') return 'var(--status-red)'
  return 'var(--status-orange)'
}

const statusLabelKey = (status: RemoteConnectionStatus): TranslationKey => {
  switch (status) {
    case 'loggedOut':
      return 'remote.statusLoggedOut'
    case 'connecting':
      return 'remote.statusConnecting'
    case 'online':
      return 'remote.statusOnline'
    case 'reconnecting':
      return 'remote.statusReconnecting'
    case 'revoked':
      return 'remote.statusRevoked'
    default:
      return 'remote.statusDisabled'
  }
}

const formatPairingCode = (code: string) =>
  code
    .replace(/\s|-/g, '')
    .match(/.{1,4}/g)
    ?.join('-') ?? code

const formatExpiry = (timestamp: number, language: string) =>
  new Date(timestamp).toLocaleTimeString(language.startsWith('zh') ? 'zh-CN' : 'en-US', {
    hour: '2-digit',
    minute: '2-digit',
  })

const formatAuditTime = (timestamp: number, language: string) =>
  new Date(timestamp).toLocaleString(language.startsWith('zh') ? 'zh-CN' : 'en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })

const copyText = async (value: string): Promise<boolean> => {
  if (!navigator.clipboard) return false
  try {
    await navigator.clipboard.writeText(value)
    return true
  } catch {
    return false
  }
}

const DeviceRow = ({
  device,
  onRevoke,
  revokeLabel,
}: {
  device: RemoteDevice
  onRevoke: (device: RemoteDevice) => void
  revokeLabel: string
}) => (
  <div
    className="flex items-center gap-2 rounded border px-2.5 py-2"
    style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}
    data-testid={`remote-device-${device.id}`}
  >
    <Smartphone size={14} className="shrink-0 text-sec" aria-hidden />
    <div className="min-w-0 flex-1">
      <div className="truncate text-sm font-medium text-pri">{device.name}</div>
      <div className="text-ter text-xs">
        {device.lastActive ? new Date(device.lastActive).toLocaleDateString() : '—'}
      </div>
    </div>
    <button
      type="button"
      className="icon-btn icon-btn--danger"
      onClick={() => onRevoke(device)}
      aria-label={`${revokeLabel}: ${device.name}`}
      data-testid={`remote-revoke-${device.id}`}
    >
      <Unplug size={13} aria-hidden />
      <span>{revokeLabel}</span>
    </button>
  </div>
)

const AuditRows = ({ records, language }: { records: RemoteAuditRecord[]; language: string }) => (
  <div
    className="mt-2 max-h-40 overflow-y-auto rounded border"
    style={{ borderColor: 'var(--border)' }}
  >
    {records.length === 0 ? (
      <div className="px-3 py-2 text-xs text-ter">—</div>
    ) : (
      records.map((record) => (
        <div
          key={record.id}
          className="flex items-start gap-2 border-b px-3 py-2 text-xs last:border-b-0"
          style={{ borderColor: 'var(--border)' }}
        >
          <span className="mono shrink-0 text-ter">{formatAuditTime(record.ts, language)}</span>
          <span className="min-w-0 flex-1 truncate text-sec">
            {record.action} {record.endpoint ?? ''}
          </span>
          <span
            style={{ color: record.result === 'ok' ? 'var(--status-green)' : 'var(--status-red)' }}
          >
            {record.result}
          </span>
        </div>
      ))
    )}
  </div>
)

export const RemoteAccessButton = () => {
  const { language, t } = useI18n()
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<RemoteStatus | null>(null)
  const [devices, setDevices] = useState<RemoteDevice[]>([])
  const [pending, setPending] = useState<RemotePendingPairing[]>([])
  const [ticket, setTicket] = useState<RemotePairingTicket | null>(null)
  const [audit, setAudit] = useState<RemoteAuditRecord[]>([])
  const [showAudit, setShowAudit] = useState(false)
  const [revokeTarget, setRevokeTarget] = useState<RemoteDevice | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const loadPanel = useCallback(
    async (showLoading = false) => {
      if (showLoading) setLoading(true)
      try {
        const nextStatus = await getRemoteStatus()
        setStatus(nextStatus)
        if (!nextStatus.loggedIn) {
          setDevices([])
          setPending([])
          return
        }
        const [nextDevices, nextPending] = await Promise.all([
          listRemoteDevices(),
          nextStatus.enabled ? listRemotePairings() : Promise.resolve([]),
        ])
        setDevices(nextDevices)
        setPending(nextPending)
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : t('remote.unableToLoad'))
      } finally {
        if (showLoading) setLoading(false)
      }
    },
    [t]
  )

  useEffect(() => {
    void getRemoteStatus()
      .then(setStatus)
      .catch(() => {
        // The runtime offline state is rendered elsewhere; keep this trigger quiet.
      })
  }, [])

  useEffect(() => {
    if (!open) return
    void loadPanel(true)
    const timer = window.setInterval(() => void loadPanel(), 3000)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [loadPanel, open])

  const runAction = async (action: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await action()
      await loadPanel()
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : t('remote.unableToLoad'))
    } finally {
      setBusy(false)
    }
  }

  const handleCopy = async (value: string) => {
    const ok = await copyText(value)
    setCopied(ok)
    if (ok) window.setTimeout(() => setCopied(false), 1600)
  }

  const activePending = pending[0] ?? null
  const effectiveStatus = status?.status ?? 'disabled'
  const label = status ? t(statusLabelKey(effectiveStatus)) : t('common.loading')
  const color = statusColor(effectiveStatus, status?.enabled ?? false)
  const pairingCopy = ticket ? `${ticket.code}\n${ticket.qr}` : ''

  return (
    <div ref={containerRef} className="relative">
      <Tooltip label={t('remote.status')}>
        <button
          ref={triggerRef}
          type="button"
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-label={t('remote.status')}
          className="flex h-7 cursor-pointer items-center gap-1.5 rounded px-2 text-xs font-medium text-sec hover:bg-3 hover:text-pri focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
          data-testid="topbar-remote"
          onClick={() => setOpen((value) => !value)}
        >
          <Globe2 size={14} aria-hidden />
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} aria-hidden />
          <span>{label}</span>
        </button>
      </Tooltip>

      {open ? (
        <div
          role="dialog"
          aria-label={t('remote.status')}
          className="elev-2 absolute top-8 right-0 z-50 max-h-[calc(100vh-64px)] w-[460px] max-w-[calc(100vw-24px)] overflow-y-auto rounded border p-4"
          style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border-bright)' }}
          data-testid="remote-access-panel"
        >
          <div className="flex items-start gap-2">
            <div
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded"
              style={{
                background: `color-mix(in oklab, ${color} 15%, transparent)`,
                color,
              }}
            >
              <ShieldCheck size={16} aria-hidden />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-sm font-semibold text-pri">
                {t('remote.status')}
                <span className="text-xs font-normal" style={{ color }}>
                  {label}
                </span>
              </div>
              <div className="text-ter text-xs">{t('remote.subtitle')}</div>
            </div>
            <button
              type="button"
              className="icon-btn icon-btn--ghost h-7 w-7 justify-center p-0"
              aria-label={t('common.closeDialog')}
              onClick={() => setOpen(false)}
            >
              <X size={14} aria-hidden />
            </button>
          </div>

          {loading ? (
            <div
              className="mt-4 rounded border px-3 py-3 text-sm text-ter"
              style={{ borderColor: 'var(--border)' }}
            >
              {t('common.loading')}
            </div>
          ) : error && !status ? (
            <div
              className="mt-4 rounded border px-3 py-3 text-sm"
              style={{
                background: 'color-mix(in oklab, var(--status-red) 8%, transparent)',
                borderColor: 'color-mix(in oklab, var(--status-red) 35%, var(--border))',
                color: 'var(--status-red)',
              }}
            >
              {error}
              <button
                type="button"
                className="icon-btn mt-2"
                onClick={() => void loadPanel(true)}
                data-testid="remote-retry"
              >
                <RefreshCw size={13} aria-hidden />
                <span>{t('common.retry')}</span>
              </button>
            </div>
          ) : (
            <>
              {error ? (
                <div
                  className="mt-3 rounded border px-3 py-2 text-xs"
                  style={{
                    background: 'color-mix(in oklab, var(--status-red) 8%, transparent)',
                    borderColor: 'color-mix(in oklab, var(--status-red) 35%, var(--border))',
                    color: 'var(--status-red)',
                  }}
                >
                  {error}
                </div>
              ) : null}

              {!status?.loggedIn ? (
                <section
                  className="mt-4 rounded border p-3"
                  style={{ borderColor: 'var(--border)' }}
                >
                  <div className="flex items-center gap-2 text-sm font-medium text-pri">
                    <Cloud size={14} aria-hidden />
                    {t('remote.loginRequired')}
                  </div>
                  <div className="mt-1 text-xs text-ter">{t('remote.loginCommand')}</div>
                  <div
                    className="mt-2 flex items-center gap-2 rounded border px-2.5 py-2"
                    style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}
                  >
                    <code className="mono min-w-0 flex-1 text-xs text-sec">hive remote login</code>
                    <button
                      type="button"
                      className="icon-btn h-7 w-7 justify-center p-0"
                      aria-label={t('remote.copyCommand')}
                      onClick={() => void handleCopy('hive remote login')}
                    >
                      {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
                    </button>
                  </div>
                </section>
              ) : (
                <>
                  <section
                    className="mt-4 rounded border p-3"
                    style={{ borderColor: 'var(--border)' }}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-pri">{t('remote.enabled')}</div>
                        <div className="mt-1 truncate text-xs text-ter">
                          {t('remote.gateway')}: {status.gatewayUrl ?? '—'}
                        </div>
                      </div>
                      <button
                        type="button"
                        className={status.enabled ? 'icon-btn icon-btn--primary' : 'icon-btn'}
                        aria-pressed={status.enabled}
                        disabled={busy}
                        onClick={() =>
                          void runAction(async () => setRemoteEnabled(!status.enabled))
                        }
                        data-testid="remote-toggle"
                      >
                        <span>{status.enabled ? t('common.running') : t('remote.enable')}</span>
                      </button>
                    </div>
                  </section>

                  {status.enabled ? (
                    <section
                      className="mt-3 rounded border p-3"
                      style={{ borderColor: 'var(--border)' }}
                    >
                      <div className="flex items-center gap-2 text-sm font-medium text-pri">
                        <Smartphone size={14} aria-hidden />
                        {t('remote.startPairing')}
                      </div>
                      <div className="mt-1 text-xs text-ter">{t('remote.pairingHint')}</div>
                      {ticket ? (
                        <div
                          className="mt-3 rounded border p-3"
                          style={{ background: 'var(--bg-2)', borderColor: 'var(--border-bright)' }}
                        >
                          <div className="text-xs text-ter">{t('remote.pairingCode')}</div>
                          <div
                            className="mono mt-1 text-xl font-semibold tracking-[0.16em] text-pri"
                            data-testid="remote-pairing-code"
                          >
                            {formatPairingCode(ticket.code)}
                          </div>
                          <div className="mt-1 text-xs text-ter">
                            {t('remote.pairingExpires', {
                              time: formatExpiry(ticket.expiresAt, language),
                            })}
                          </div>
                          <button
                            type="button"
                            className="icon-btn mt-3"
                            onClick={() => void handleCopy(pairingCopy)}
                            data-testid="remote-copy-pairing"
                          >
                            {copied ? (
                              <Check size={13} aria-hidden />
                            ) : (
                              <Clipboard size={13} aria-hidden />
                            )}
                            <span>{copied ? t('remote.codeCopied') : t('remote.copyCode')}</span>
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="icon-btn icon-btn--primary mt-3"
                          disabled={busy || status.status === 'disabled'}
                          onClick={() =>
                            void runAction(async () => {
                              const nextTicket = await beginRemotePairing()
                              setTicket(nextTicket)
                              setPending([])
                            })
                          }
                          data-testid="remote-start-pairing"
                        >
                          <Smartphone size={13} aria-hidden />
                          <span>{t('remote.startPairing')}</span>
                        </button>
                      )}
                    </section>
                  ) : null}

                  {status.enabled ? (
                    <section
                      className="mt-3 rounded border p-3"
                      style={{ borderColor: 'var(--border)' }}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-sm font-medium text-pri">{t('remote.pending')}</div>
                        <button
                          type="button"
                          className="icon-btn h-7 w-7 justify-center p-0"
                          aria-label={t('remote.refresh')}
                          disabled={busy}
                          onClick={() => void loadPanel()}
                        >
                          <RefreshCw size={13} aria-hidden />
                        </button>
                      </div>
                      {activePending ? (
                        <div
                          className="mt-2 rounded border p-3"
                          style={{ background: 'var(--bg-2)', borderColor: 'var(--border-bright)' }}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="min-w-0">
                              <div className="truncate text-sm font-medium text-pri">
                                {activePending.deviceName ?? t('remote.deviceName')}
                              </div>
                              <div className="mt-1 text-xs text-ter">
                                {t('remote.pairingExpires', {
                                  time: formatExpiry(activePending.expiresAt, language),
                                })}
                              </div>
                            </div>
                            <div
                              className="mono text-xl font-semibold tracking-[0.12em] text-pri"
                              data-testid="remote-pending-sas"
                            >
                              {activePending.sas}
                            </div>
                          </div>
                          <div className="mt-3 flex justify-end gap-2">
                            <button
                              type="button"
                              className="icon-btn icon-btn--danger"
                              disabled={busy}
                              onClick={() =>
                                void runAction(() => rejectRemotePairing(activePending.pairingId))
                              }
                            >
                              <X size={13} aria-hidden />
                              <span>{t('remote.reject')}</span>
                            </button>
                            <button
                              type="button"
                              className="icon-btn icon-btn--primary"
                              disabled={busy}
                              onClick={() =>
                                void runAction(async () => {
                                  await confirmRemotePairing(
                                    activePending.pairingId,
                                    activePending.deviceName ?? undefined
                                  )
                                  setTicket(null)
                                })
                              }
                              data-testid="remote-confirm-pairing"
                            >
                              <Check size={13} aria-hidden />
                              <span>{t('remote.confirm')}</span>
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="mt-2 text-xs text-ter">{t('remote.noPending')}</div>
                      )}
                    </section>
                  ) : null}

                  <section className="mt-3">
                    <div className="mb-2 flex items-center gap-2 text-sm font-medium text-pri">
                      <ShieldCheck size={14} aria-hidden />
                      {t('remote.devices')}
                      <span className="text-xs font-normal text-ter">{devices.length}</span>
                    </div>
                    <div className="space-y-2">
                      {devices.length === 0 ? (
                        <div
                          className="rounded border px-3 py-2 text-xs text-ter"
                          style={{ borderColor: 'var(--border)' }}
                        >
                          {t('remote.emptyDevices')}
                        </div>
                      ) : (
                        devices.map((device) => (
                          <DeviceRow
                            key={device.id}
                            device={device}
                            onRevoke={setRevokeTarget}
                            revokeLabel={t('remote.revoke')}
                          />
                        ))
                      )}
                    </div>
                  </section>

                  <section className="mt-3 border-t pt-3" style={{ borderColor: 'var(--border)' }}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 text-left text-xs text-sec hover:text-pri"
                      onClick={() => {
                        setShowAudit((value) => !value)
                        if (!showAudit)
                          void getRemoteAudit()
                            .then(setAudit)
                            .catch(() => {})
                      }}
                      aria-expanded={showAudit}
                    >
                      <ExternalLink size={12} aria-hidden />
                      <span>{t('remote.audit')}</span>
                    </button>
                    {showAudit ? <AuditRows records={audit} language={language} /> : null}
                  </section>
                </>
              )}
            </>
          )}
        </div>
      ) : null}

      <Confirm
        open={revokeTarget !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setRevokeTarget(null)
        }}
        title={t('remote.revokeTitle')}
        description={t('remote.revokeConfirm', { name: revokeTarget?.name ?? '' })}
        confirmLabel={t('remote.revoke')}
        confirmKind="danger"
        onConfirm={() => {
          const target = revokeTarget
          setRevokeTarget(null)
          if (target) void runAction(() => revokeRemoteDevice(target.id))
        }}
      />
    </div>
  )
}
