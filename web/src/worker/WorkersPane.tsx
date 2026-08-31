import { Sparkles, Terminal, UserPlus } from 'lucide-react'
import { useMemo, useState } from 'react'

import type { TeamListItem } from '../../../src/shared/types.js'
import type { TerminalRunSummary } from '../api.js'
import { useI18n } from '../i18n.js'
import { Confirm } from '../ui/Confirm.js'
import { EmptyState } from '../ui/EmptyState.js'
import { WorkerAvatarDialog } from './WorkerAvatarDialog.js'
import { WorkerCard, type WorkerCardActionKind } from './WorkerCard.js'
import { presentWorkerStatus, type WorkerStatusKind } from './worker-status.js'

type WorkersPaneProps = {
  autoResumeBusy?: boolean
  autoResumeOnRestart?: boolean | undefined
  onAddWorkerClick: () => void
  onAutoResumeChange?: (enabled: boolean) => void
  onDeleteWorker: (worker: TeamListItem) => void
  onOpenShellTerminal?: () => void
  onOpenWorker: (worker: TeamListItem) => void
  onRenameWorker: (worker: TeamListItem, newName: string) => Promise<{ error: string | null }>
  onScenarioClick?: () => void
  onStartWorker: (worker: TeamListItem) => void
  onStopWorker?: (worker: TeamListItem, runId: string) => void
  onUpdateWorkerAvatar?: (worker: TeamListItem, avatar: string | null) => Promise<void>
  shellTerminalAvailable?: boolean
  stoppingWorkerId?: string | null
  startingWorkerId: string | null
  terminalRuns: TerminalRunSummary[]
  workers: TeamListItem[]
}

const SECTION_ORDER: WorkerStatusKind[] = ['working', 'idle', 'stopped']
const statusKey = (status: WorkerStatusKind) => {
  if (status === 'working') return 'common.running'
  if (status === 'idle') return 'common.idle'
  return 'common.stopped'
}

const summarizeWorkers = (workers: TeamListItem[]) => {
  const buckets: Record<WorkerStatusKind, TeamListItem[]> = {
    idle: [],
    working: [],
    stopped: [],
  }
  for (const worker of workers) buckets[presentWorkerStatus(worker).kind].push(worker)
  return {
    sections: SECTION_ORDER.filter((kind) => buckets[kind].length > 0).map((kind) => ({
      kind,
      workers: buckets[kind],
    })),
    summary: {
      idle: buckets.idle.length,
      stopped: buckets.stopped.length,
      working: buckets.working.length,
    },
  }
}

export const WorkersPane = ({
  autoResumeBusy = false,
  autoResumeOnRestart,
  onAddWorkerClick,
  onAutoResumeChange,
  onDeleteWorker,
  onOpenShellTerminal,
  onOpenWorker,
  onRenameWorker,
  onScenarioClick,
  onStartWorker,
  onStopWorker,
  onUpdateWorkerAvatar,
  shellTerminalAvailable = true,
  stoppingWorkerId = null,
  startingWorkerId,
  terminalRuns,
  workers,
}: WorkersPaneProps) => {
  const { t } = useI18n()
  const { sections, summary } = useMemo(() => summarizeWorkers(workers), [workers])
  const runIdsByAgentId = useMemo(
    () => new Map(terminalRuns.map((run) => [run.agent_id, run.run_id] as const)),
    [terminalRuns]
  )
  const [pendingDelete, setPendingDelete] = useState<TeamListItem | null>(null)
  const [editingWorkerId, setEditingWorkerId] = useState<string | null>(null)
  const [editingAvatarWorker, setEditingAvatarWorker] = useState<TeamListItem | null>(null)
  const [renameBusyWorkerId, setRenameBusyWorkerId] = useState<string | null>(null)

  const handleAction = (kind: WorkerCardActionKind, worker: TeamListItem) => {
    if (kind === 'start') {
      onStartWorker(worker)
      return
    }
    if (kind === 'stop') {
      const runId = runIdsByAgentId.get(worker.id)
      if (runId) onStopWorker?.(worker, runId)
      return
    }
    if (kind === 'rename') {
      setEditingWorkerId(worker.id)
      return
    }
    if (kind === 'avatar') {
      if (!onUpdateWorkerAvatar) return
      setEditingAvatarWorker(worker)
      return
    }
    if (kind === 'delete') {
      setPendingDelete(worker)
    }
  }

  const confirmDelete = () => {
    if (!pendingDelete) return
    onDeleteWorker(pendingDelete)
    setPendingDelete(null)
  }

  const submitRename = async (worker: TeamListItem, newName: string) => {
    setRenameBusyWorkerId(worker.id)
    try {
      const result = await onRenameWorker(worker, newName)
      if (!result.error) setEditingWorkerId(null)
      return result
    } finally {
      setRenameBusyWorkerId(null)
    }
  }

  return (
    <div
      className="workers-pane flex min-h-0 min-w-0 flex-1 flex-col"
      style={{ background: 'var(--bg-2)' }}
    >
      <div
        className="workers-pane-header flex shrink-0 flex-col gap-1 px-4 pt-3 pb-2.5"
        style={{
          boxShadow: 'inset 0 -1px 0 var(--border)',
        }}
      >
        <div className="workers-pane-header__row flex items-center gap-2.5">
          <span className="text-lg font-semibold text-pri">{t('worker.teamMembers')}</span>
          <span className="mono inline-flex min-w-7 items-center justify-center rounded bg-3 px-2.5 py-1 text-base leading-none text-sec">
            {workers.length}
          </span>
          <div className="workers-pane-header__actions ml-auto flex items-center gap-1.5">
            {autoResumeOnRestart !== undefined && onAutoResumeChange ? (
              <label className="workers-pane-auto-resume mr-1 inline-flex items-center gap-1.5 text-xs text-sec">
                <input
                  type="checkbox"
                  checked={autoResumeOnRestart}
                  disabled={autoResumeBusy}
                  onChange={(event) => onAutoResumeChange(event.target.checked)}
                  aria-label={t('worker.autoResumeAria')}
                  data-testid="workspace-auto-resume"
                />
                <span>{t('worker.autoResume')}</span>
              </label>
            ) : null}
            {shellTerminalAvailable ? (
              <button
                type="button"
                onClick={onOpenShellTerminal}
                className="workers-pane-action icon-btn icon-btn--tertiary"
                aria-label={t('shellTerminal.openAria')}
                data-testid="open-workspace-shell"
              >
                <Terminal size={14} aria-hidden />
                <span className="workers-pane-action__label">{t('shellTerminal.open')}</span>
              </button>
            ) : null}
            {onScenarioClick ? (
              <button
                type="button"
                onClick={onScenarioClick}
                className="workers-pane-action icon-btn icon-btn--tertiary"
                data-testid="team-scenario-trigger"
              >
                <Sparkles size={14} aria-hidden />
                <span className="workers-pane-action__label">{t('scenario.open')}</span>
              </button>
            ) : null}
            <button
              type="button"
              onClick={onAddWorkerClick}
              className="workers-pane-action icon-btn icon-btn--primary"
              data-testid="add-worker-trigger"
            >
              <UserPlus size={14} aria-hidden />
              <span className="workers-pane-action__label">{t('addWorker.create')}</span>
            </button>
          </div>
        </div>
        {workers.length > 0 ? (
          <div className="workers-pane-summary flex flex-wrap items-center gap-3 text-xs text-ter">
            <span className="inline-flex items-center gap-1.5">
              <span className="status-dot status-dot--working" aria-hidden />
              <span className="text-sec">{summary.working}</span> {t('common.running')}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="status-dot status-dot--idle" aria-hidden />
              <span className="text-sec">{summary.idle}</span> {t('common.idle')}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="status-dot status-dot--stopped" aria-hidden />
              <span className="text-sec">{summary.stopped}</span> {t('common.stopped')}
            </span>
          </div>
        ) : null}
      </div>

      <div className="workers-pane-body scroll-y flex-1 px-2 py-2">
        {workers.length === 0 ? (
          <EmptyState
            icon={<UserPlus size={28} />}
            title={t('worker.emptyTitle')}
            description={t('worker.emptyDesc')}
            action={
              <div className="flex flex-wrap justify-center gap-2">
                {onScenarioClick ? (
                  <button
                    type="button"
                    onClick={onScenarioClick}
                    className="icon-btn"
                    data-testid="team-scenario-empty"
                  >
                    <Sparkles size={14} aria-hidden /> {t('scenario.open')}
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={onAddWorkerClick}
                  className="icon-btn icon-btn--primary"
                  data-testid="add-worker-empty"
                >
                  <UserPlus size={14} aria-hidden /> {t('worker.emptyAdd')}
                </button>
              </div>
            }
          />
        ) : (
          <div data-testid="worker-grid">
            {sections.map((section) => (
              <section key={section.kind} className="mb-3 last:mb-0">
                <div className="px-2 py-1 text-xs font-medium uppercase tracking-wider text-ter">
                  {t(statusKey(section.kind))}
                  <span className="mono ml-1.5 text-ter">{section.workers.length}</span>
                </div>
                <ul
                  aria-label={`${t(statusKey(section.kind))} team members`}
                  className="worker-card-grid"
                >
                  {section.workers.map((worker) => (
                    <li key={worker.id}>
                      <WorkerCard
                        canEditAvatar={onUpdateWorkerAvatar !== undefined}
                        hasRun={runIdsByAgentId.has(worker.id)}
                        isEditing={editingWorkerId === worker.id}
                        isPending={startingWorkerId === worker.id || stoppingWorkerId === worker.id}
                        onAction={handleAction}
                        onCancelRename={() => setEditingWorkerId(null)}
                        onClick={onOpenWorker}
                        onRename={submitRename}
                        renameBusy={renameBusyWorkerId === worker.id}
                        worker={worker}
                      />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>

      <Confirm
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null)
        }}
        title={pendingDelete ? t('worker.deleteConfirm', { name: pendingDelete.name }) : ''}
        description={
          pendingDelete ? t('worker.deleteDescription', { name: pendingDelete.name }) : ''
        }
        confirmLabel={t('worker.deleteMember')}
        confirmKind="danger"
        onConfirm={confirmDelete}
      />
      {editingAvatarWorker && onUpdateWorkerAvatar ? (
        <WorkerAvatarDialog
          key={editingAvatarWorker.id}
          worker={editingAvatarWorker}
          onClose={() => setEditingAvatarWorker(null)}
          onSave={(avatar) => onUpdateWorkerAvatar(editingAvatarWorker, avatar)}
        />
      ) : null}
    </div>
  )
}
