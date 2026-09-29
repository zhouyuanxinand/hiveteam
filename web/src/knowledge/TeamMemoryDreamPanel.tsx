import { CheckCircle2, RotateCcw, Save, Sparkles } from 'lucide-react'
import { MEMORY_DREAM_PLAN_VERSION } from '../../../src/shared/memory-dream-plan.js'
import { MemoryDreamDiff } from './MemoryDreamDiff.js'
import { MemoryDreamCitations, MemoryDreamGeneration } from './MemoryDreamGeneration.js'
import { invalidDreamOperations, MemoryDreamOperations } from './MemoryDreamOperations.js'
import { useMemoryDreamRuns } from './useMemoryDreamRuns.js'
import './memory-dream.css'
import { type TranslationKey, useI18n } from '../i18n.js'
import {
  createTeamMemoryDream,
  discardTeamMemoryDream,
  generateTeamMemoryDream,
  rollbackTeamMemoryDream,
  submitTeamMemoryDream,
  updateTeamMemoryDream,
} from './memory-dream-api.js'

interface TeamMemoryDreamPanelProps {
  dreamEnabled: boolean
  onDreamEnabledChange: (enabled: boolean) => Promise<void>
  onMemoryChanged: () => void
  open: boolean
  settingsBusy: boolean
  workspaceId: string
}

export const TeamMemoryDreamPanel = ({
  dreamEnabled,
  onDreamEnabledChange,
  onMemoryChanged,
  open,
  settingsBusy,
  workspaceId,
}: TeamMemoryDreamPanelProps) => {
  const { t, language } = useI18n()
  const zh = language === 'zh'
  const {
    runs,
    current,
    loading,
    busy,
    historyLoading,
    reviewOnly,
    reviewCount,
    hasMore,
    filterHistory,
    loadMore,
    error,
    noNewMessages,
    select,
    edit,
    perform,
  } = useMemoryDreamRuns(workspaceId, open)
  const prepare = () => perform(() => createTeamMemoryDream(workspaceId))
  const generate = (retry = false) => perform(() => generateTeamMemoryDream(workspaceId, retry))
  const save = () =>
    current &&
    perform(() =>
      updateTeamMemoryDream(workspaceId, current.id, current.planRevision, current.operations)
    )
  const submit = () =>
    current &&
    perform(
      () =>
        submitTeamMemoryDream(workspaceId, current.id, current.planRevision, current.operations),
      onMemoryChanged
    )
  const rollback = () =>
    current && perform(() => rollbackTeamMemoryDream(workspaceId, current.id), onMemoryChanged)
  const discard = () =>
    current && perform(() => discardTeamMemoryDream(workspaceId, current.id, current.planRevision))
  const invalid = current ? invalidDreamOperations(current.operations) : false
  const generationReady = !current?.generation || current.generation.status === 'completed'
  const editable =
    current?.planVersion === MEMORY_DREAM_PLAN_VERSION &&
    current.status === 'review' &&
    generationReady

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
          <p className="mt-1 text-xs text-ter">
            {zh
              ? '审阅明确的记忆变更，再一次性应用；来源已变化时整批停止。'
              : 'Review explicit memory changes, then apply them together. Changed sources stop the whole apply.'}
          </p>
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
      </div>
      <div className="memory-dream-create-actions">
        <button
          type="button"
          className="icon-btn"
          onClick={() => void prepare()}
          disabled={busy || loading}
          data-testid="memory-dream-new"
        >
          <Sparkles size={13} aria-hidden /> {t('memory.dream.prepare')}
        </button>
        <button
          type="button"
          className="icon-btn icon-btn--primary"
          onClick={() => void generate()}
          disabled={busy || loading}
          data-testid="memory-dream-generate"
        >
          {zh ? '从新消息生成候选' : 'Generate from new messages'}
        </button>
      </div>
      <p className="mt-2 text-xs text-ter">
        {zh
          ? '新消息候选来自可追溯的团队协议消息，不扫描终端历史。生成后仍需审核与应用。'
          : 'Candidates use traceable team protocol messages, without scanning terminal history. Review and apply are still required.'}
      </p>
      {noNewMessages ? (
        <p role="status" className="mt-2 text-xs">
          {zh
            ? '没有新的可处理消息，未请求模型生成。'
            : 'No new eligible messages. No model generation was requested.'}
        </p>
      ) : null}

      {loading ? <p className="mt-3 text-xs text-ter">{t('common.loading')}</p> : null}
      {error ? (
        <p className="mt-3 text-xs text-red-400" role="alert">
          {error}
        </p>
      ) : null}

      {!loading && (runs.length > 0 || reviewCount > 0) ? (
        <div className="memory-dream-history-controls">
          <fieldset aria-label={zh ? '历史记录筛选' : 'History filter'}>
            <button
              type="button"
              className="icon-btn"
              aria-pressed={!reviewOnly}
              disabled={busy}
              onClick={() => void filterHistory(false)}
              data-testid="memory-dream-history-all"
            >
              {zh ? '全部历史' : 'All history'}
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-pressed={reviewOnly}
              disabled={busy}
              onClick={() => void filterHistory(true)}
              data-testid="memory-dream-history-review"
            >
              {zh ? '待审草稿' : 'Needs review'} (
              <span data-testid="memory-dream-review-count">{reviewCount}</span>)
            </button>
          </fieldset>
          {historyLoading ? <span role="status">{t('common.loading')}</span> : null}
        </div>
      ) : null}
      {runs.length > 1 ? (
        <select
          disabled={busy}
          value={current?.id ?? ''}
          onChange={(event) => {
            const selected = runs.find((run) => run.id === event.target.value)
            if (selected) select(selected)
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

      {hasMore ? (
        <button
          type="button"
          className="icon-btn mt-2"
          disabled={busy || loading}
          onClick={() => void loadMore()}
          data-testid="memory-dream-history-more"
        >
          {zh ? '加载更早记录' : 'Load earlier records'}
        </button>
      ) : null}
      {reviewOnly && reviewCount === 0 && !loading ? (
        <p className="mt-2 text-xs text-ter" role="status">
          {zh
            ? '没有待审草稿。可在全部历史中查看变更回执。'
            : 'No drafts need review. View change receipts in All history.'}
        </p>
      ) : null}

      {current ? (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-ter">
            {generationReady ? (
              <span className="rounded bg-3 px-2 py-1">
                {t(`memory.dream.status.${current.status}` as TranslationKey)}
              </span>
            ) : null}
            {!current.generation ? (
              <span className="rounded bg-3 px-2 py-1">
                {t(`memory.dream.execution.${current.executionStatus}` as TranslationKey)}
              </span>
            ) : null}
            <span>{t('memory.dream.orchestratorOnly')}</span>
          </div>
          {!current.generation && current.executionError ? (
            <p className="mt-2 text-xs text-red-400" role="alert">
              {t('memory.dream.executionError', { message: current.executionError })}
            </p>
          ) : null}
          {current.generation ? (
            <MemoryDreamGeneration
              generation={current.generation}
              busy={busy}
              onRetry={() => void generate(true)}
            />
          ) : null}
          {current.status === 'discarded' && current.generation?.candidate_count !== 0 ? (
            <p className="mt-3 text-xs">
              {zh
                ? '本批提案未采纳，现有记忆未变更。可以继续处理后续消息。'
                : 'This batch was discarded. Existing memories are unchanged; later messages can now be processed.'}
            </p>
          ) : null}
          {current.planVersion !== MEMORY_DREAM_PLAN_VERSION ? (
            <div className="mt-3 text-xs">
              <p>
                {zh
                  ? '旧版 Dream 仅供查看。请重新生成，以记录来源版本并安全应用。'
                  : 'This legacy Dream is read-only. Prepare a new Dream to capture source versions and apply safely.'}
              </p>
              {current.suggestions.map((suggestion) => (
                <p
                  key={`${current.id}-${suggestion.sourceMemoryIds.join(':')}-${suggestion.body}`}
                  className="memory-dream-body mt-2"
                >
                  {suggestion.body}
                </p>
              ))}
            </div>
          ) : editable ? (
            <MemoryDreamOperations
              operations={current.operations}
              snapshots={current.sourceSnapshots}
              disabled={busy}
              messages={current.generation?.input.messages ?? []}
              onChange={(operations) => edit({ ...current, operations })}
            />
          ) : current.receipt ? (
            <div className="mt-3 text-xs" data-testid="memory-dream-receipt">
              <p>
                {zh ? '变更回执' : 'Change receipt'} · {current.receipt.actor.name} ·{' '}
                {new Date(current.receipt.applied_at).toLocaleString()}
              </p>
              {current.receipt.changes.map((change) => (
                <div key={change.memory_id}>
                  <MemoryDreamDiff
                    memoryId={change.memory_id}
                    before={change.before}
                    after={change.after}
                  />
                  <MemoryDreamCitations
                    messages={current.receipt?.message_evidence?.messages ?? []}
                    sequences={
                      current.receipt?.message_evidence?.citations.find(
                        (citation) => citation.operation_id === change.operation_id
                      )?.sequences ?? []
                    }
                  />
                </div>
              ))}
              {current.status === 'rolled_back' ? (
                <p className="mt-2">
                  {zh
                    ? '以上为应用时的记录；已恢复原有记忆，并归档本次新增的记忆。'
                    : 'This is the original apply receipt. Existing memories were restored and newly created memories were archived.'}
                </p>
              ) : null}
            </div>
          ) : null}
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            {editable ? (
              <>
                <button
                  type="button"
                  className="icon-btn"
                  disabled={busy}
                  onClick={() => void discard()}
                  data-testid="memory-dream-discard"
                >
                  {zh ? '不采纳本批提案' : 'Discard this batch'}
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  disabled={busy || invalid}
                  onClick={() => void save()}
                  data-testid="memory-dream-save"
                >
                  <Save size={13} aria-hidden /> {t('memory.dream.saveReview')}
                </button>
                <button
                  type="button"
                  className="icon-btn icon-btn--primary"
                  disabled={busy || current.operations.length === 0 || invalid}
                  onClick={() => void submit()}
                  data-testid="memory-dream-submit"
                >
                  <CheckCircle2 size={13} aria-hidden /> {t('memory.dream.submit')}
                </button>
              </>
            ) : null}
            {current.planVersion === MEMORY_DREAM_PLAN_VERSION &&
            current.receipt &&
            current.status === 'submitted' ? (
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
