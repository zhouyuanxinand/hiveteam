import * as Dialog from '@radix-ui/react-dialog'
import { Check, Download, LoaderCircle, Sparkles, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import type { TeamListItem } from '../../../src/shared/types.js'
import {
  launchTeamScenario,
  listTeamScenarios,
  type TeamScenarioCatalog,
  TeamScenarioLaunchError,
} from '../api.js'
import { type TranslationKey, useI18n } from '../i18n.js'

interface TeamScenarioDialogProps {
  onClose: () => void
  onWorkersChanged: (workers: TeamListItem[]) => void
  open: boolean
  workspaceId: string
}

const scenarioTitleKey = (id: string): TranslationKey => {
  if (id === 'fix-a-bug') return 'scenario.fixBug'
  if (id === 'understand-a-repo') return 'scenario.understandRepo'
  return 'scenario.shipFeature'
}

const scenarioDescriptionKey = (id: string): TranslationKey => {
  if (id === 'fix-a-bug') return 'scenario.fixBugDescription'
  if (id === 'understand-a-repo') return 'scenario.understandRepoDescription'
  return 'scenario.shipFeatureDescription'
}

export const TeamScenarioDialog = ({
  onClose,
  onWorkersChanged,
  open,
  workspaceId,
}: TeamScenarioDialogProps) => {
  const { t } = useI18n()
  const [catalog, setCatalog] = useState<TeamScenarioCatalog | null>(null)
  const [scenarioId, setScenarioId] = useState('ship-feature')
  const [presetId, setPresetId] = useState('codex')
  const [autostart, setAutostart] = useState(true)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [missing, setMissing] = useState<TeamScenarioCatalog['presets']>([])

  useEffect(() => {
    if (!open) return
    let active = true
    setLoading(true)
    setError(null)
    void listTeamScenarios()
      .then((next) => {
        if (!active) return
        setCatalog(next)
        const preferred = next.presets.find((preset) => preset.id === 'codex')
        const firstAvailable = next.presets.find((preset) => preset.available)
        setPresetId(preferred?.id ?? firstAvailable?.id ?? next.presets[0]?.id ?? 'codex')
      })
      .catch((loadError: unknown) => {
        if (active) setError(loadError instanceof Error ? loadError.message : String(loadError))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [open])

  const selectedPreset = useMemo(
    () => catalog?.presets.find((preset) => preset.id === presetId) ?? null,
    [catalog, presetId]
  )
  const selectedScenario = useMemo(
    () => catalog?.scenarios.find((scenario) => scenario.id === scenarioId) ?? null,
    [catalog, scenarioId]
  )

  const handleLaunch = async () => {
    if (!selectedScenario || !presetId) return
    setBusy(true)
    setError(null)
    setMissing([])
    try {
      const result = await launchTeamScenario(workspaceId, selectedScenario.id, {
        autostart,
        commandPresetId: presetId,
      })
      onWorkersChanged(result.workers)
      onClose()
    } catch (launchError: unknown) {
      if (launchError instanceof TeamScenarioLaunchError) {
        setMissing(launchError.missing)
        setError(launchError.message)
      } else {
        setError(launchError instanceof Error ? launchError.message : String(launchError))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="app-overlay fixed inset-0 z-40" />
        <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center p-4">
          <Dialog.Content
            className="dialog-scale-pop elev-2 pointer-events-auto flex max-h-[calc(100vh-32px)] w-[620px] max-w-full flex-col overflow-hidden rounded-lg border"
            style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border-bright)' }}
            data-testid="team-scenario-dialog"
          >
            <header
              className="flex shrink-0 items-start gap-3 border-b px-5 py-4"
              style={{ borderColor: 'var(--border)' }}
            >
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-3 text-accent">
                <Sparkles size={18} aria-hidden />
              </div>
              <div className="min-w-0 flex-1">
                <Dialog.Title className="text-lg font-semibold text-pri">
                  {t('scenario.title')}
                </Dialog.Title>
                <Dialog.Description className="mt-0.5 text-sm text-ter">
                  {t('scenario.description')}
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <button type="button" className="icon-btn" aria-label={t('common.close')}>
                  <X size={16} aria-hidden />
                </button>
              </Dialog.Close>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              {loading ? (
                <div className="flex items-center justify-center gap-2 py-12 text-sm text-ter">
                  <LoaderCircle size={16} className="animate-spin" aria-hidden />{' '}
                  {t('common.loading')}
                </div>
              ) : catalog ? (
                <>
                  <section>
                    <div className="mb-2 text-xs font-medium uppercase tracking-wider text-ter">
                      {t('scenario.choose')}
                    </div>
                    <div
                      className="grid gap-2 sm:grid-cols-3"
                      role="radiogroup"
                      aria-label={t('scenario.choose')}
                    >
                      {catalog.scenarios.map((scenario) => {
                        const selected = scenario.id === scenarioId
                        return (
                          <button
                            key={scenario.id}
                            type="button"
                            aria-pressed={selected}
                            onClick={() => setScenarioId(scenario.id)}
                            className="rounded border p-3 text-left transition-colors hover:bg-3"
                            style={{
                              background: selected
                                ? 'color-mix(in oklab, var(--accent) 10%, var(--bg-2))'
                                : 'var(--bg-2)',
                              borderColor: selected ? 'var(--accent)' : 'var(--border)',
                            }}
                            data-testid={`team-scenario-${scenario.id}`}
                          >
                            <span className="flex items-center justify-between gap-2 text-sm font-medium text-pri">
                              {t(scenarioTitleKey(scenario.id))}
                              {selected ? (
                                <Check size={14} className="text-accent" aria-hidden />
                              ) : null}
                            </span>
                            <span className="mt-1 block text-xs text-ter">
                              {t(scenarioDescriptionKey(scenario.id))}
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  </section>

                  <section className="mt-5">
                    <label
                      className="mb-2 block text-xs font-medium uppercase tracking-wider text-ter"
                      htmlFor="team-scenario-preset"
                    >
                      {t('scenario.cli')}
                    </label>
                    <select
                      id="team-scenario-preset"
                      value={presetId}
                      onChange={(event) => setPresetId(event.target.value)}
                      className="w-full rounded border px-3 py-2 text-sm text-pri"
                      style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}
                      data-testid="team-scenario-preset"
                    >
                      {catalog.presets.map((preset) => (
                        <option key={preset.id} value={preset.id}>
                          {preset.displayName}
                          {preset.available ? '' : ` — ${t('scenario.notInstalled')}`}
                        </option>
                      ))}
                    </select>
                    {selectedPreset && !selectedPreset.available ? (
                      <div
                        className="mt-2 rounded border p-3 text-xs text-sec"
                        style={{
                          borderColor:
                            'color-mix(in oklab, var(--status-orange) 45%, var(--border))',
                        }}
                      >
                        <div className="flex items-start gap-2">
                          <Download size={14} className="mt-0.5 shrink-0 text-accent" aria-hidden />
                          <span>{selectedPreset.installHint ?? t('scenario.installHint')}</span>
                        </div>
                      </div>
                    ) : null}
                  </section>

                  <section className="mt-4">
                    <label className="inline-flex items-center gap-2 text-sm text-sec">
                      <input
                        type="checkbox"
                        checked={autostart}
                        onChange={(event) => setAutostart(event.target.checked)}
                      />
                      {t('scenario.autostart')}
                    </label>
                    <p className="mt-1 text-xs text-ter">
                      {t('scenario.memberSummary', {
                        count: selectedScenario?.members.length ?? 0,
                      })}
                    </p>
                  </section>
                </>
              ) : null}

              {error ? (
                <div
                  className="mt-4 rounded border p-3 text-sm text-sec"
                  style={{
                    borderColor: 'color-mix(in oklab, var(--status-red) 45%, var(--border))',
                  }}
                  role="alert"
                >
                  <div>{error}</div>
                  {missing.map((preset) => (
                    <div key={preset.id} className="mt-2 text-xs text-ter">
                      {preset.installHint}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>

            <footer
              className="flex shrink-0 justify-end gap-2 border-t px-5 py-3"
              style={{ borderColor: 'var(--border)' }}
            >
              <button type="button" className="icon-btn" onClick={onClose}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="icon-btn icon-btn--primary"
                disabled={busy || loading || !selectedScenario || !selectedPreset?.available}
                onClick={() => void handleLaunch()}
                data-testid="team-scenario-launch"
              >
                {busy ? t('scenario.starting') : t('scenario.launch')}
              </button>
            </footer>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
