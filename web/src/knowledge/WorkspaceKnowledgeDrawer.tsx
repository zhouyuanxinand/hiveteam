import * as Dialog from '@radix-ui/react-dialog'
import {
  Archive,
  ArchiveRestore,
  Brain,
  Eye,
  EyeOff,
  FileCode2,
  Pin,
  PinOff,
  Plus,
  Search,
  Sparkles,
  Workflow,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { TeamListItem } from '../../../src/shared/types.js'
import {
  createTeamMemory,
  getTeamMemorySettings,
  listTeamMemory,
  listWorkspaceWorkflowState,
  runWorkspaceWorkflow,
  setTeamMemoryEnabled,
  stopWorkspaceWorkflow,
  type TeamMemoryEntry,
  type TeamMemoryKind,
  type TeamMemoryScope,
  updateTeamMemory,
  type WorkflowDefinition,
  type WorkflowRun,
} from '../api.js'
import { type TranslationKey, useI18n } from '../i18n.js'
import { TeamMemoryDreamPanel } from './TeamMemoryDreamPanel.js'

export type KnowledgeTab = 'memory' | 'workflows'

interface WorkspaceKnowledgeDrawerProps {
  initialTab: KnowledgeTab
  onClose: () => void
  open: boolean
  workspaceId: string
  workers?: readonly TeamListItem[]
}

const MEMORY_KINDS: TeamMemoryKind[] = [
  'decision',
  'fact',
  'preference',
  'pitfall',
  'procedure_ref',
]

const kindKey = (kind: TeamMemoryKind) =>
  `memory.kind.${kind}` as
    | 'memory.kind.decision'
    | 'memory.kind.fact'
    | 'memory.kind.pitfall'
    | 'memory.kind.preference'
    | 'memory.kind.procedure_ref'

export const WorkspaceKnowledgeDrawer = ({
  initialTab,
  onClose,
  open,
  workspaceId,
  workers = [],
}: WorkspaceKnowledgeDrawerProps) => {
  const { language, t } = useI18n()
  const [tab, setTab] = useState<KnowledgeTab>(initialTab)
  const [memoryStatus, setMemoryStatus] = useState<'active' | 'archived'>('active')
  const [memories, setMemories] = useState<TeamMemoryEntry[]>([])
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([])
  const [workflowRuns, setWorkflowRuns] = useState<WorkflowRun[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [memoryEnabled, setMemoryEnabledState] = useState(true)
  const [settingsBusy, setSettingsBusy] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [composerOpen, setComposerOpen] = useState(false)
  const [newBody, setNewBody] = useState('')
  const [newKind, setNewKind] = useState<TeamMemoryKind>('decision')
  const [newScope, setNewScope] = useState<TeamMemoryScope>('workspace')
  const [newTags, setNewTags] = useState('')
  const [createBusy, setCreateBusy] = useState(false)
  const [dreamOpen, setDreamOpen] = useState(false)
  const [memoryRefresh, setMemoryRefresh] = useState(0)
  const [workflowBusyId, setWorkflowBusyId] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setTab(initialTab)
      setQuery('')
    }
  }, [initialTab, open])

  useEffect(() => {
    if (!open) return
    // Incrementing memoryRefresh deliberately retriggers this request after a
    // Dream submit/rollback without changing the active filters.
    void memoryRefresh
    let active = true
    setLoading(true)
    setError(null)
    const load =
      tab === 'memory'
        ? Promise.all([
            listTeamMemory(workspaceId, { status: memoryStatus }),
            getTeamMemorySettings(workspaceId),
          ]).then(([entries, settings]) => {
            if (!active) return
            setMemories(entries)
            setMemoryEnabledState(settings.enabled)
          })
        : listWorkspaceWorkflowState(workspaceId).then((state) => {
            if (!active) return
            setWorkflows(state.workflows)
            setWorkflowRuns(state.runs)
          })
    void load
      .catch((loadError: unknown) => {
        if (active) setError(loadError instanceof Error ? loadError.message : String(loadError))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [memoryRefresh, memoryStatus, open, tab, workspaceId])

  const hasRunningWorkflow = workflowRuns.some((run) => run.status === 'running')

  useEffect(() => {
    if (!open || tab !== 'workflows' || !hasRunningWorkflow) return
    let active = true
    const refresh = async () => {
      try {
        const state = await listWorkspaceWorkflowState(workspaceId)
        if (!active) return
        setWorkflows(state.workflows)
        setWorkflowRuns(state.runs)
      } catch {
        // Keep the last known run state; the next refresh or user action can retry.
      }
    }
    const timer = window.setInterval(() => void refresh(), 2_000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [hasRunningWorkflow, open, tab, workspaceId])

  const normalizedQuery = query.trim().toLowerCase()
  const visibleMemories = useMemo(
    () =>
      memories.filter(
        (entry) =>
          !normalizedQuery ||
          entry.body.toLowerCase().includes(normalizedQuery) ||
          entry.tags.some((tag) => tag.toLowerCase().includes(normalizedQuery))
      ),
    [memories, normalizedQuery]
  )
  const visibleWorkflows = useMemo(
    () =>
      workflows.filter(
        (workflow) =>
          !normalizedQuery ||
          workflow.name.toLowerCase().includes(normalizedQuery) ||
          workflow.description.toLowerCase().includes(normalizedQuery) ||
          workflow.path.toLowerCase().includes(normalizedQuery)
      ),
    [normalizedQuery, workflows]
  )

  const latestRunForWorkflow = (workflowId: string) =>
    workflowRuns.find((run) => run.workflowId === workflowId)

  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-US', {
        dateStyle: 'medium',
        timeStyle: 'short',
      }),
    [language]
  )

  const handleMemoryUpdate = async (
    entry: TeamMemoryEntry,
    patch: Parameters<typeof updateTeamMemory>[2]
  ) => {
    setEditingId(entry.id)
    setError(null)
    try {
      const updated = await updateTeamMemory(workspaceId, entry.id, patch)
      if (updated.status !== memoryStatus) {
        setMemories((current) => current.filter((item) => item.id !== entry.id))
      } else {
        setMemories((current) => current.map((item) => (item.id === updated.id ? updated : item)))
      }
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : String(updateError))
    } finally {
      setEditingId(null)
    }
  }

  const handleCreate = async () => {
    if (!newBody.trim()) return
    setCreateBusy(true)
    setError(null)
    try {
      const created = await createTeamMemory(workspaceId, {
        body: newBody,
        kind: newKind,
        scope: newScope,
        tags: newTags
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean),
      })
      if (memoryStatus === 'active') setMemories((current) => [created, ...current])
      setNewBody('')
      setNewTags('')
      setComposerOpen(false)
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError))
    } finally {
      setCreateBusy(false)
    }
  }

  const handleEnabledChange = async (enabled: boolean) => {
    setSettingsBusy(true)
    setError(null)
    try {
      await setTeamMemoryEnabled(workspaceId, enabled)
      setMemoryEnabledState(enabled)
    } catch (settingsError) {
      setError(settingsError instanceof Error ? settingsError.message : String(settingsError))
    } finally {
      setSettingsBusy(false)
    }
  }

  const handleRunWorkflow = async (workflow: WorkflowDefinition) => {
    if (!workflow.runnable) return
    setWorkflowBusyId(workflow.id)
    setError(null)
    try {
      const run = await runWorkspaceWorkflow(workspaceId, workflow.id)
      setWorkflowRuns((current) => [run, ...current.filter((item) => item.id !== run.id)])
    } catch (runError: unknown) {
      setError(runError instanceof Error ? runError.message : String(runError))
    } finally {
      setWorkflowBusyId(null)
    }
  }

  const handleStopWorkflow = async (run: WorkflowRun) => {
    setWorkflowBusyId(run.workflowId)
    setError(null)
    try {
      const stopped = await stopWorkspaceWorkflow(workspaceId, run.id)
      setWorkflowRuns((current) => current.map((item) => (item.id === stopped.id ? stopped : item)))
    } catch (stopError: unknown) {
      setError(stopError instanceof Error ? stopError.message : String(stopError))
    } finally {
      setWorkflowBusyId(null)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="app-overlay workspace-knowledge-overlay fixed inset-0 z-40" />
        <Dialog.Content
          className="workspace-knowledge-drawer fixed z-50 flex flex-col border-l"
          data-testid="workspace-knowledge-drawer"
        >
          <header className="workspace-knowledge-header">
            <div className="min-w-0">
              <Dialog.Title className="text-lg font-semibold text-pri">
                {tab === 'memory' ? t('memory.title') : t('workflows.title')}
              </Dialog.Title>
              <Dialog.Description className="mt-0.5 text-xs text-ter">
                {tab === 'memory' ? t('memory.description') : t('workflows.description')}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                className="workspace-knowledge-close"
                aria-label={t('common.close')}
              >
                <X size={16} aria-hidden />
              </button>
            </Dialog.Close>
          </header>

          <div className="workspace-knowledge-toolbar">
            <div
              className="workspace-knowledge-tabs"
              role="tablist"
              aria-label={t('knowledge.tabs')}
            >
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'memory'}
                data-active={tab === 'memory' ? 'true' : undefined}
                onClick={() => setTab('memory')}
              >
                <Brain size={14} aria-hidden /> {t('memory.tab')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'workflows'}
                data-active={tab === 'workflows' ? 'true' : undefined}
                onClick={() => setTab('workflows')}
              >
                <Workflow size={14} aria-hidden /> {t('workflows.tab')}
              </button>
            </div>
            <label className="workspace-knowledge-search">
              <Search size={14} aria-hidden />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={
                  tab === 'memory'
                    ? t('memory.searchPlaceholder')
                    : t('workflows.searchPlaceholder')
                }
                aria-label={t('knowledge.searchAria')}
              />
            </label>
          </div>

          {tab === 'memory' ? (
            <div className="workspace-knowledge-subbar">
              <div className="workspace-knowledge-filter-tabs" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={memoryStatus === 'active'}
                  data-active={memoryStatus === 'active' ? 'true' : undefined}
                  onClick={() => setMemoryStatus('active')}
                >
                  {t('memory.active')}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={memoryStatus === 'archived'}
                  data-active={memoryStatus === 'archived' ? 'true' : undefined}
                  onClick={() => setMemoryStatus('archived')}
                >
                  {t('memory.archived')}
                </button>
              </div>
              <label className="workspace-memory-enabled">
                <input
                  type="checkbox"
                  checked={memoryEnabled}
                  disabled={settingsBusy}
                  onChange={(event) => void handleEnabledChange(event.target.checked)}
                />
                <span>{t('memory.injectEnabled')}</span>
              </label>
              <button
                type="button"
                className="icon-btn icon-btn--primary workspace-memory-add"
                onClick={() => setComposerOpen((current) => !current)}
              >
                <Plus size={14} aria-hidden /> {t('memory.add')}
              </button>
              <button
                type="button"
                className="icon-btn workspace-memory-dream"
                onClick={() => setDreamOpen((current) => !current)}
                aria-pressed={dreamOpen}
                data-testid="memory-dream-toggle"
              >
                <Sparkles size={14} aria-hidden /> {t('memory.dream.tab')}
              </button>
            </div>
          ) : null}

          {error ? (
            <div className="workspace-knowledge-error" role="alert">
              {error}
            </div>
          ) : null}

          <div className="workspace-knowledge-body scroll-y">
            {tab === 'memory' ? (
              <>
                <TeamMemoryDreamPanel
                  onMemoryChanged={() => setMemoryRefresh((value) => value + 1)}
                  open={dreamOpen}
                  workspaceId={workspaceId}
                  workers={workers}
                />
                {composerOpen ? (
                  <section className="workspace-memory-composer" aria-label={t('memory.add')}>
                    <textarea
                      value={newBody}
                      onChange={(event) => setNewBody(event.target.value)}
                      maxLength={4000}
                      placeholder={t('memory.bodyPlaceholder')}
                    />
                    <div className="workspace-memory-composer__fields">
                      <select
                        value={newKind}
                        onChange={(event) => setNewKind(event.target.value as TeamMemoryKind)}
                        aria-label={t('memory.kindAria')}
                      >
                        {MEMORY_KINDS.map((kind) => (
                          <option key={kind} value={kind}>
                            {t(kindKey(kind))}
                          </option>
                        ))}
                      </select>
                      <select
                        value={newScope}
                        onChange={(event) => setNewScope(event.target.value as TeamMemoryScope)}
                        aria-label={t('memory.scopeAria')}
                      >
                        <option value="workspace">{t('memory.scope.workspace')}</option>
                        <option value="user">{t('memory.scope.user')}</option>
                      </select>
                      <input
                        value={newTags}
                        onChange={(event) => setNewTags(event.target.value)}
                        placeholder={t('memory.tagsPlaceholder')}
                        aria-label={t('memory.tagsAria')}
                      />
                    </div>
                    <div className="workspace-memory-composer__actions">
                      <button
                        type="button"
                        className="icon-btn icon-btn--tertiary"
                        onClick={() => setComposerOpen(false)}
                      >
                        {t('common.cancel')}
                      </button>
                      <button
                        type="button"
                        className="icon-btn icon-btn--primary"
                        disabled={createBusy || !newBody.trim()}
                        onClick={() => void handleCreate()}
                      >
                        {createBusy ? t('common.saving') : t('common.save')}
                      </button>
                    </div>
                  </section>
                ) : null}
                {loading ? (
                  <KnowledgeState>{t('common.loading')}</KnowledgeState>
                ) : visibleMemories.length === 0 ? (
                  <KnowledgeState icon={<Brain size={26} />}>
                    {query ? t('memory.noResults') : t('memory.empty')}
                  </KnowledgeState>
                ) : (
                  <ul className="workspace-memory-list">
                    {visibleMemories.map((entry) => (
                      <li
                        key={entry.id}
                        className="workspace-memory-card"
                        data-disabled={entry.disabled ? 'true' : undefined}
                      >
                        <div className="workspace-memory-card__meta">
                          <span className="workspace-memory-kind">{t(kindKey(entry.kind))}</span>
                          <span>
                            {entry.scope === 'user'
                              ? t('memory.scope.user')
                              : t('memory.scope.workspace')}
                          </span>
                          {entry.pinned ? <span>{t('memory.pinned')}</span> : null}
                          {entry.disabled ? <span>{t('memory.disabled')}</span> : null}
                        </div>
                        <p>{entry.body}</p>
                        {entry.tags.length ? (
                          <div className="workspace-memory-tags">
                            {entry.tags.map((tag) => (
                              <span key={tag}>#{tag}</span>
                            ))}
                          </div>
                        ) : null}
                        <div className="workspace-memory-card__footer">
                          <time dateTime={new Date(entry.updatedAt).toISOString()}>
                            {dateFormatter.format(entry.updatedAt)}
                          </time>
                          <div className="workspace-memory-card__actions">
                            {memoryStatus === 'active' ? (
                              <>
                                <MemoryAction
                                  label={entry.pinned ? t('memory.unpin') : t('memory.pin')}
                                  disabled={editingId === entry.id}
                                  onClick={() =>
                                    void handleMemoryUpdate(entry, { pinned: !entry.pinned })
                                  }
                                >
                                  {entry.pinned ? <PinOff size={14} /> : <Pin size={14} />}
                                </MemoryAction>
                                <MemoryAction
                                  label={entry.disabled ? t('memory.enable') : t('memory.disable')}
                                  disabled={editingId === entry.id}
                                  onClick={() =>
                                    void handleMemoryUpdate(entry, { disabled: !entry.disabled })
                                  }
                                >
                                  {entry.disabled ? <Eye size={14} /> : <EyeOff size={14} />}
                                </MemoryAction>
                                <MemoryAction
                                  label={t('memory.archive')}
                                  disabled={editingId === entry.id}
                                  onClick={() =>
                                    void handleMemoryUpdate(entry, { status: 'archived' })
                                  }
                                >
                                  <Archive size={14} />
                                </MemoryAction>
                              </>
                            ) : (
                              <MemoryAction
                                label={t('memory.restore')}
                                disabled={editingId === entry.id}
                                onClick={() => void handleMemoryUpdate(entry, { status: 'active' })}
                              >
                                <ArchiveRestore size={14} />
                              </MemoryAction>
                            )}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : loading ? (
              <KnowledgeState>{t('common.loading')}</KnowledgeState>
            ) : visibleWorkflows.length === 0 ? (
              <KnowledgeState icon={<Workflow size={26} />}>
                {query ? t('workflows.noResults') : t('workflows.empty')}
                {!query ? <code>.hive/workflows</code> : null}
              </KnowledgeState>
            ) : (
              <ul className="workspace-workflow-list">
                {visibleWorkflows.map((workflow) => (
                  <li key={workflow.id} className="workspace-workflow-card">
                    <FileCode2 size={18} aria-hidden />
                    <div className="min-w-0">
                      <strong>{workflow.name}</strong>
                      {workflow.description ? <p>{workflow.description}</p> : null}
                      <code>{workflow.path}</code>
                      {workflow.validationError ? (
                        <p className="text-red-400">
                          {workflow.runnable
                            ? workflow.validationError
                            : t('workflows.invalid', { message: workflow.validationError })}
                        </p>
                      ) : null}
                      {(() => {
                        const latestRun = latestRunForWorkflow(workflow.id)
                        if (!latestRun) return null
                        const completedSteps = latestRun.steps.filter(
                          (step) => step.status === 'completed'
                        ).length
                        return (
                          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-ter">
                            <span>{t(`workflows.${latestRun.status}` as TranslationKey)}</span>
                            <span>
                              {t('workflows.steps', {
                                completed: completedSteps,
                                total: latestRun.steps.length,
                              })}
                            </span>
                            {latestRun.error ? <span>{latestRun.error}</span> : null}
                            {latestRun.status === 'running' ? (
                              <button
                                type="button"
                                className="icon-btn"
                                disabled={workflowBusyId === workflow.id}
                                onClick={() => void handleStopWorkflow(latestRun)}
                              >
                                {t('workflows.stop')}
                              </button>
                            ) : null}
                          </div>
                        )
                      })()}
                    </div>
                    <div className="workspace-workflow-card__actions">
                      <time dateTime={new Date(workflow.updatedAt).toISOString()}>
                        {dateFormatter.format(workflow.updatedAt)}
                      </time>
                      <button
                        type="button"
                        className="icon-btn icon-btn--primary"
                        disabled={!workflow.runnable || workflowBusyId === workflow.id}
                        onClick={() => void handleRunWorkflow(workflow)}
                      >
                        {t('workflows.run')}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

const KnowledgeState = ({
  children,
  icon,
}: {
  children: React.ReactNode
  icon?: React.ReactNode
}) => (
  <div className="workspace-knowledge-state">
    {icon}
    <span>{children}</span>
  </div>
)

const MemoryAction = ({
  children,
  disabled,
  label,
  onClick,
}: {
  children: React.ReactNode
  disabled: boolean
  label: string
  onClick: () => void
}) => (
  <button type="button" disabled={disabled} onClick={onClick} aria-label={label} title={label}>
    {children}
  </button>
)
