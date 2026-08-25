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
  Workflow,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import {
  createTeamMemory,
  getTeamMemorySettings,
  listTeamMemory,
  listWorkspaceWorkflows,
  setTeamMemoryEnabled,
  type TeamMemoryEntry,
  type TeamMemoryKind,
  type TeamMemoryScope,
  updateTeamMemory,
  type WorkflowDefinition,
} from '../api.js'
import { useI18n } from '../i18n.js'

export type KnowledgeTab = 'memory' | 'workflows'

interface WorkspaceKnowledgeDrawerProps {
  initialTab: KnowledgeTab
  onClose: () => void
  open: boolean
  workspaceId: string
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
}: WorkspaceKnowledgeDrawerProps) => {
  const { language, t } = useI18n()
  const [tab, setTab] = useState<KnowledgeTab>(initialTab)
  const [memoryStatus, setMemoryStatus] = useState<'active' | 'archived'>('active')
  const [memories, setMemories] = useState<TeamMemoryEntry[]>([])
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([])
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

  useEffect(() => {
    if (open) {
      setTab(initialTab)
      setQuery('')
    }
  }, [initialTab, open])

  useEffect(() => {
    if (!open) return
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
        : listWorkspaceWorkflows(workspaceId).then((entries) => {
            if (active) setWorkflows(entries)
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
  }, [memoryStatus, open, tab, workspaceId])

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
                    </div>
                    <time dateTime={new Date(workflow.updatedAt).toISOString()}>
                      {dateFormatter.format(workflow.updatedAt)}
                    </time>
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
