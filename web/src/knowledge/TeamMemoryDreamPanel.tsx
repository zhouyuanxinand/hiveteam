import { CheckCircle2, RotateCcw, Save, Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'
import type {
  TeamMemoryKind,
  TeamMemoryProcedureRef,
  TeamMemoryProcedureRefType,
} from '../../../src/shared/team-memory.js'
import {
  createTeamMemoryDream,
  listTeamMemoryDreams,
  rollbackTeamMemoryDream,
  submitTeamMemoryDream,
  type TeamMemoryDreamRun,
  updateTeamMemoryDream,
} from '../api.js'
import { type TranslationKey, useI18n } from '../i18n.js'

interface TeamMemoryDreamPanelProps {
  dreamEnabled: boolean
  onDreamEnabledChange: (enabled: boolean) => Promise<void>
  onMemoryChanged: () => void
  open: boolean
  settingsBusy: boolean
  workspaceId: string
}

const MEMORY_KINDS: TeamMemoryKind[] = [
  'decision',
  'fact',
  'preference',
  'pitfall',
  'procedure_ref',
]

const PROCEDURE_REF_TYPES: TeamMemoryProcedureRefType[] = [
  'workflow',
  'skill',
  'procedure',
  'template',
  'doc',
]

const kindKey = (kind: TeamMemoryKind): TranslationKey => `memory.kind.${kind}` as TranslationKey
const procedureRefTypeKey = (type: TeamMemoryProcedureRefType): TranslationKey =>
  `memory.procedureRef.type.${type}` as TranslationKey

const emptyProcedureRef = (): TeamMemoryProcedureRef => ({
  id: '',
  title: null,
  type: 'workflow',
})

export const TeamMemoryDreamPanel = ({
  dreamEnabled,
  onDreamEnabledChange,
  onMemoryChanged,
  open,
  settingsBusy,
  workspaceId,
}: TeamMemoryDreamPanelProps) => {
  const { t } = useI18n()
  const [runs, setRuns] = useState<TeamMemoryDreamRun[]>([])
  const [current, setCurrent] = useState<TeamMemoryDreamRun | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let active = true
    setLoading(true)
    setError(null)
    void listTeamMemoryDreams(workspaceId)
      .then((next) => {
        if (!active) return
        setRuns(next)
        setCurrent(next.find((run) => run.status === 'review') ?? next[0] ?? null)
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
  }, [open, workspaceId])

  const replaceRun = (next: TeamMemoryDreamRun) => {
    setCurrent(next)
    setRuns((previous) => [next, ...previous.filter((run) => run.id !== next.id)])
  }

  const prepare = async () => {
    setBusy(true)
    setError(null)
    try {
      replaceRun(await createTeamMemoryDream(workspaceId))
    } catch (prepareError: unknown) {
      setError(prepareError instanceof Error ? prepareError.message : String(prepareError))
    } finally {
      setBusy(false)
    }
  }

  const save = async () => {
    if (!current || current.status !== 'review') return
    setBusy(true)
    setError(null)
    try {
      replaceRun(await updateTeamMemoryDream(workspaceId, current.id, current.suggestions))
    } catch (saveError: unknown) {
      setError(saveError instanceof Error ? saveError.message : String(saveError))
    } finally {
      setBusy(false)
    }
  }

  const submit = async () => {
    if (!current || current.status !== 'review') return
    setBusy(true)
    setError(null)
    try {
      const next = await submitTeamMemoryDream(workspaceId, current.id)
      replaceRun(next)
      onMemoryChanged()
    } catch (submitError: unknown) {
      setError(submitError instanceof Error ? submitError.message : String(submitError))
    } finally {
      setBusy(false)
    }
  }

  const rollback = async () => {
    if (!current || current.status !== 'submitted') return
    setBusy(true)
    setError(null)
    try {
      const next = await rollbackTeamMemoryDream(workspaceId, current.id)
      replaceRun(next)
      onMemoryChanged()
    } catch (rollbackError: unknown) {
      setError(rollbackError instanceof Error ? rollbackError.message : String(rollbackError))
    } finally {
      setBusy(false)
    }
  }

  const updateSuggestion = (
    index: number,
    patch: Partial<TeamMemoryDreamRun['suggestions'][number]>
  ) => {
    if (!current || current.status !== 'review') return
    setCurrent({
      ...current,
      suggestions: current.suggestions.map((suggestion, suggestionIndex) =>
        suggestionIndex === index ? { ...suggestion, ...patch } : suggestion
      ),
    })
  }

  const hasIncompleteProcedureRef =
    current?.status === 'review' &&
    current.suggestions.some(
      (suggestion) => suggestion.kind === 'procedure_ref' && !suggestion.procedureRef?.id.trim()
    )

  if (!open) return null

  return (
    <section
      className="workspace-memory-dream rounded border p-3"
      style={{ borderColor: 'var(--border-bright)', background: 'var(--bg-1)' }}
      data-testid="memory-dream-panel"
    >
      <div className="flex items-start gap-2">
        <Sparkles size={16} className="mt-0.5 shrink-0 text-accent" aria-hidden />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-pri">{t('memory.dream.title')}</h3>
          <p className="mt-1 text-xs text-ter">{t('memory.dream.description')}</p>
          <label className="workspace-memory-dream-schedule mt-2">
            <input
              type="checkbox"
              checked={dreamEnabled}
              disabled={settingsBusy}
              onChange={(event) => void onDreamEnabledChange(event.target.checked)}
            />
            <span>{t('memory.dream.scheduleEnabled')}</span>
          </label>
          <p className="mt-1 text-xs text-ter">{t('memory.dream.scheduleHint')}</p>
        </div>
        <button
          type="button"
          className="icon-btn"
          onClick={() => void prepare()}
          disabled={busy}
          data-testid="memory-dream-new"
        >
          <Sparkles size={13} aria-hidden /> {t('memory.dream.prepare')}
        </button>
      </div>

      {loading ? <p className="mt-3 text-xs text-ter">{t('common.loading')}</p> : null}
      {error ? (
        <p className="mt-3 text-xs text-red-400" role="alert">
          {error}
        </p>
      ) : null}

      {runs.length > 1 ? (
        <select
          value={current?.id ?? ''}
          onChange={(event) => {
            const selected = runs.find((run) => run.id === event.target.value)
            if (selected) setCurrent(selected)
          }}
          className="mt-3 w-full rounded border px-2 py-1.5 text-xs text-pri"
          style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}
          aria-label={t('memory.dream.title')}
          data-testid="memory-dream-history"
        >
          {runs.map((run) => (
            <option key={run.id} value={run.id}>
              {new Date(run.createdAt).toLocaleString()} ·{' '}
              {t(`memory.dream.status.${run.status}` as TranslationKey)}
            </option>
          ))}
        </select>
      ) : null}

      {current ? (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-ter">
            <span className="rounded bg-3 px-2 py-1">
              {t(`memory.dream.status.${current.status}` as TranslationKey)}
            </span>
            <span className="rounded bg-3 px-2 py-1">
              {t(`memory.dream.execution.${current.executionStatus}` as TranslationKey)}
            </span>
            <span>{t('memory.dream.orchestratorOnly')}</span>
          </div>
          {current.executionError ? (
            <p className="mt-2 text-xs text-red-400" role="alert">
              {t('memory.dream.executionError', { message: current.executionError })}
            </p>
          ) : null}
          {current.suggestions.length === 0 ? (
            <p className="mt-3 text-xs text-ter">{t('memory.dream.noSuggestions')}</p>
          ) : (
            <div className="mt-3 space-y-2">
              {current.suggestions.map((suggestion, index) => (
                <div
                  key={`${current.id}-${suggestion.sourceMemoryIds.join(':')}`}
                  className="rounded border p-2"
                  style={{ borderColor: 'var(--border)' }}
                >
                  <div className="mb-2 flex items-center gap-2">
                    <select
                      value={suggestion.kind}
                      disabled={current.status !== 'review' || busy}
                      onChange={(event) => {
                        const kind = event.target.value as TeamMemoryKind
                        updateSuggestion(index, {
                          kind,
                          procedureRef:
                            kind === 'procedure_ref'
                              ? (suggestion.procedureRef ?? emptyProcedureRef())
                              : null,
                        })
                      }}
                      className="rounded border px-2 py-1 text-xs text-pri"
                      style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}
                      aria-label={t('memory.kindAria')}
                    >
                      {MEMORY_KINDS.map((kind) => (
                        <option key={kind} value={kind}>
                          {t(kindKey(kind))}
                        </option>
                      ))}
                    </select>
                    <span className="text-xs text-ter">
                      {t('memory.dream.sourceCount', { count: suggestion.sourceMemoryIds.length })}
                    </span>
                  </div>
                  {suggestion.kind === 'procedure_ref' ? (
                    <fieldset className="workspace-memory-procedure-ref">
                      <legend>{t('memory.procedureRef.title')}</legend>
                      <div className="workspace-memory-procedure-ref__fields">
                        <label>
                          <span>{t('memory.procedureRef.typeLabel')}</span>
                          <select
                            value={suggestion.procedureRef?.type ?? 'workflow'}
                            disabled={current.status !== 'review' || busy}
                            onChange={(event) =>
                              updateSuggestion(index, {
                                procedureRef: {
                                  ...(suggestion.procedureRef ?? emptyProcedureRef()),
                                  type: event.target.value as TeamMemoryProcedureRefType,
                                },
                              })
                            }
                            aria-label={t('memory.procedureRef.typeLabel')}
                          >
                            {PROCEDURE_REF_TYPES.map((type) => (
                              <option key={type} value={type}>
                                {t(procedureRefTypeKey(type))}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          <span>{t('memory.procedureRef.idLabel')}</span>
                          <input
                            value={suggestion.procedureRef?.id ?? ''}
                            disabled={current.status !== 'review' || busy}
                            maxLength={256}
                            placeholder={t('memory.procedureRef.idPlaceholder')}
                            onChange={(event) =>
                              updateSuggestion(index, {
                                procedureRef: {
                                  ...(suggestion.procedureRef ?? emptyProcedureRef()),
                                  id: event.target.value,
                                },
                              })
                            }
                            aria-label={t('memory.procedureRef.idLabel')}
                          />
                        </label>
                        <label>
                          <span>{t('memory.procedureRef.titleLabel')}</span>
                          <input
                            value={suggestion.procedureRef?.title ?? ''}
                            disabled={current.status !== 'review' || busy}
                            maxLength={160}
                            placeholder={t('memory.procedureRef.titlePlaceholder')}
                            onChange={(event) =>
                              updateSuggestion(index, {
                                procedureRef: {
                                  ...(suggestion.procedureRef ?? emptyProcedureRef()),
                                  title: event.target.value || null,
                                },
                              })
                            }
                            aria-label={t('memory.procedureRef.titleLabel')}
                          />
                        </label>
                      </div>
                    </fieldset>
                  ) : null}
                  <textarea
                    value={suggestion.body}
                    disabled={current.status !== 'review' || busy}
                    onChange={(event) => updateSuggestion(index, { body: event.target.value })}
                    className="min-h-20 w-full rounded border px-2 py-1.5 text-xs text-pri"
                    style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}
                    aria-label={t('memory.dream.suggestionAria', { index: index + 1 })}
                  />
                </div>
              ))}
            </div>
          )}
          {hasIncompleteProcedureRef ? (
            <p className="mt-2 text-xs text-red-400" role="alert">
              {t('memory.procedureRef.required')}
            </p>
          ) : null}
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            {current.status === 'review' ? (
              <>
                <button
                  type="button"
                  className="icon-btn"
                  disabled={busy || hasIncompleteProcedureRef}
                  onClick={() => void save()}
                  data-testid="memory-dream-save"
                >
                  <Save size={13} aria-hidden /> {t('memory.dream.saveReview')}
                </button>
                <button
                  type="button"
                  className="icon-btn icon-btn--primary"
                  disabled={busy || current.suggestions.length === 0 || hasIncompleteProcedureRef}
                  onClick={() => void submit()}
                  data-testid="memory-dream-submit"
                >
                  <CheckCircle2 size={13} aria-hidden /> {t('memory.dream.submit')}
                </button>
              </>
            ) : null}
            {current.status === 'submitted' ? (
              <button
                type="button"
                className="icon-btn"
                disabled={busy}
                onClick={() => void rollback()}
                data-testid="memory-dream-rollback"
              >
                <RotateCcw size={13} aria-hidden /> {t('memory.dream.rollback')}
              </button>
            ) : null}
          </div>
        </>
      ) : (
        <p className="mt-3 text-xs text-ter">{t('memory.dream.empty')}</p>
      )}
    </section>
  )
}
