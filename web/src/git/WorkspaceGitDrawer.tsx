import * as Dialog from '@radix-ui/react-dialog'
import {
  Check,
  FileDiff,
  FolderGit2,
  GitBranch,
  GitCommitHorizontal,
  RefreshCw,
  RotateCcw,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  createWorkspaceGitSnapshot,
  type GitCommitSummary,
  getWorkspaceGitStatus,
  initializeWorkspaceGit,
  listWorkspaceGitCommits,
  revertWorkspaceGitCommit,
  setWorkspaceGitAutoSnapshot,
  type WorkspaceGitStatus,
} from '../api.js'
import { type TranslationKey, useI18n } from '../i18n.js'
import { Confirm } from '../ui/Confirm.js'

interface WorkspaceGitDrawerProps {
  onClose: () => void
  open: boolean
  workspaceId: string
}

type Confirmation = { kind: 'initialize' } | { commit: GitCommitSummary; kind: 'revert' } | null

const statusLabel = (
  status: WorkspaceGitStatus,
  t: (key: TranslationKey, values?: Record<string, string | number>) => string
) => {
  if (status.state === 'not-repository') return t('git.noRepository')
  if (status.state === 'unavailable') return t('git.statusUnavailable')
  if (status.state === 'error') return t('git.statusError')
  return status.isDirty ? t('git.dirty', { count: status.changedFileCount }) : t('git.clean')
}

export const WorkspaceGitDrawer = ({ onClose, open, workspaceId }: WorkspaceGitDrawerProps) => {
  const { language, t } = useI18n()
  const [status, setStatus] = useState<WorkspaceGitStatus | null>(null)
  const [commits, setCommits] = useState<GitCommitSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<'snapshot' | 'revert' | 'initialize' | null>(null)
  const [settingsBusy, setSettingsBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<Confirmation>(null)

  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-US', {
        dateStyle: 'medium',
        timeStyle: 'short',
      }),
    [language]
  )

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [nextStatus, page] = await Promise.all([
        getWorkspaceGitStatus(workspaceId),
        listWorkspaceGitCommits(workspaceId),
      ])
      setStatus(nextStatus)
      setCommits(page.commits)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    } finally {
      setLoading(false)
    }
  }, [workspaceId])

  useEffect(() => {
    if (!open) return
    setNotice(null)
    void load()
    const timer = window.setInterval(() => void load(), 5000)
    return () => window.clearInterval(timer)
  }, [load, open])

  const handleInitialize = async () => {
    setBusy('initialize')
    setError(null)
    try {
      const nextStatus = await initializeWorkspaceGit(workspaceId)
      setStatus(nextStatus)
      setNotice(t('git.initialize'))
      const page = await listWorkspaceGitCommits(workspaceId)
      setCommits(page.commits)
    } catch (initializeError) {
      setError(initializeError instanceof Error ? initializeError.message : String(initializeError))
    } finally {
      setBusy(null)
    }
  }

  const handleSnapshot = async () => {
    setBusy('snapshot')
    setError(null)
    setNotice(null)
    try {
      const result = await createWorkspaceGitSnapshot(workspaceId, {
        expectedHead: status?.headSha ?? null,
        message: 'HiveTeam: manual workspace snapshot',
      })
      if (result.commit) {
        setNotice(t('git.snapshotCreated', { sha: result.commit.shortSha }))
      } else {
        setNotice(t('git.snapshotNoChanges'))
      }
      await load()
    } catch (snapshotError) {
      setError(snapshotError instanceof Error ? snapshotError.message : String(snapshotError))
    } finally {
      setBusy(null)
    }
  }

  const handleRevert = async (commit: GitCommitSummary) => {
    setBusy('revert')
    setError(null)
    setNotice(null)
    try {
      const result = await revertWorkspaceGitCommit(workspaceId, commit.sha, status?.headSha)
      setNotice(t('git.reverted', { sha: result.commit.shortSha }))
      await load()
    } catch (revertError) {
      setError(revertError instanceof Error ? revertError.message : String(revertError))
    } finally {
      setBusy(null)
    }
  }

  const handleAutoSnapshot = async (enabled: boolean) => {
    if (!status) return
    setSettingsBusy(true)
    setError(null)
    try {
      setStatus(await setWorkspaceGitAutoSnapshot(workspaceId, enabled))
    } catch (settingsError) {
      setError(settingsError instanceof Error ? settingsError.message : String(settingsError))
    } finally {
      setSettingsBusy(false)
    }
  }

  const state = status?.state ?? 'unknown'
  const canSnapshot = state === 'ready' && busy === null && !loading
  const canRevert = state === 'ready' && busy === null && !loading && !status?.isDirty

  return (
    <>
      <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
        <Dialog.Portal>
          <Dialog.Overlay className="app-overlay workspace-git-overlay fixed inset-0 z-40" />
          <Dialog.Content
            className="workspace-git-drawer fixed z-50 flex flex-col border-l"
            data-testid="workspace-git-drawer"
          >
            <header className="workspace-git-header">
              <div className="flex min-w-0 items-center gap-3">
                <div className="workspace-git-heading-icon" aria-hidden>
                  <FolderGit2 size={18} />
                </div>
                <div className="min-w-0">
                  <Dialog.Title className="text-lg font-semibold text-pri">
                    {t('git.title')}
                  </Dialog.Title>
                  <Dialog.Description className="mt-0.5 text-xs text-ter">
                    {t('git.description')}
                  </Dialog.Description>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  className="workspace-git-icon-button"
                  onClick={() => void load()}
                  disabled={loading}
                  aria-label={t('git.refresh')}
                  title={t('git.refresh')}
                >
                  <RefreshCw
                    size={15}
                    className={loading ? 'animate-spin' : undefined}
                    aria-hidden
                  />
                </button>
                <Dialog.Close asChild>
                  <button
                    type="button"
                    className="workspace-git-icon-button"
                    aria-label={t('common.close')}
                  >
                    <X size={16} aria-hidden />
                  </button>
                </Dialog.Close>
              </div>
            </header>

            {status ? (
              <section className="workspace-git-status" aria-label={t('git.title')}>
                <div className="workspace-git-status-main">
                  <span className={`workspace-git-state workspace-git-state--${status.state}`} />
                  <span className="font-medium text-pri">{statusLabel(status, t)}</span>
                  {status.branch ? (
                    <span className="workspace-git-branch">
                      <GitBranch size={13} aria-hidden /> {status.branch}
                    </span>
                  ) : null}
                </div>
                {status.state === 'ready' ? (
                  <div className="workspace-git-actions">
                    <button
                      type="button"
                      className="icon-btn icon-btn--primary"
                      onClick={() => void handleSnapshot()}
                      disabled={!canSnapshot}
                    >
                      <GitCommitHorizontal size={14} aria-hidden />
                      {busy === 'snapshot' ? t('git.snapshotting') : t('git.manualSnapshot')}
                    </button>
                    <label className="workspace-git-auto">
                      <input
                        type="checkbox"
                        checked={status.autoSnapshotEnabled}
                        disabled={settingsBusy}
                        onChange={(event) => void handleAutoSnapshot(event.target.checked)}
                      />
                      <span>{t('git.autoSnapshot')}</span>
                    </label>
                  </div>
                ) : null}
              </section>
            ) : null}

            {error ? (
              <div className="workspace-git-message workspace-git-message--error" role="alert">
                {error}
              </div>
            ) : null}
            {notice ? (
              <div className="workspace-git-message workspace-git-message--notice">{notice}</div>
            ) : null}

            {status?.state === 'not-repository' ? (
              <div className="workspace-git-empty">
                <FolderGit2 size={28} aria-hidden />
                <strong>{t('git.noRepository')}</strong>
                <p>{status.workspacePath}</p>
                <button
                  type="button"
                  className="icon-btn icon-btn--primary"
                  onClick={() => setConfirmation({ kind: 'initialize' })}
                  disabled={busy !== null}
                >
                  <FolderGit2 size={14} aria-hidden />
                  {busy === 'initialize' ? t('common.saving') : t('git.initialize')}
                </button>
              </div>
            ) : (
              <div className="workspace-git-body scroll-y">
                <div className="workspace-git-section-heading">
                  <div>
                    <h3>{t('git.history')}</h3>
                    <p>{status?.branch ? `${t('git.branch')}: ${status.branch}` : ''}</p>
                  </div>
                  {status?.state === 'ready' && status.isDirty ? (
                    <span className="workspace-git-dirty-note">
                      <FileDiff size={13} aria-hidden />
                      {t('git.dirty', { count: status.changedFileCount })}
                    </span>
                  ) : null}
                </div>

                {loading && commits.length === 0 ? (
                  <div className="workspace-git-empty">
                    <RefreshCw size={20} className="animate-spin" aria-hidden />
                    {t('git.loading')}
                  </div>
                ) : commits.length === 0 ? (
                  <div className="workspace-git-empty">
                    <GitCommitHorizontal size={22} aria-hidden />
                    {t('git.noHistory')}
                  </div>
                ) : (
                  <div className="workspace-git-commit-list">
                    {commits.map((commit) => (
                      <article className="workspace-git-commit" key={commit.sha}>
                        <div className="workspace-git-commit-topline">
                          <div className="min-w-0">
                            <h4 title={commit.message}>{commit.message}</h4>
                            <div className="workspace-git-commit-meta">
                              <code>{commit.shortSha}</code>
                              <span>{dateFormatter.format(commit.committedAt)}</span>
                              <span>{t('git.commitBy', { name: commit.authorName })}</span>
                            </div>
                          </div>
                          {commit.isHiveTeamSnapshot ? (
                            <span className="workspace-git-badge">
                              <Check size={12} aria-hidden /> HiveTeam
                            </span>
                          ) : null}
                        </div>
                        <div className="workspace-git-commit-bottomline">
                          <span className="workspace-git-stats">
                            <FileDiff size={13} aria-hidden />{' '}
                            {t('git.files', { count: commit.changedFiles })}
                            <span className="workspace-git-additions">+{commit.insertions}</span>
                            <span className="workspace-git-deletions">−{commit.deletions}</span>
                          </span>
                          {commit.isHiveTeamSnapshot && !commit.revertedBySha ? (
                            <button
                              type="button"
                              className="workspace-git-revert"
                              disabled={!canRevert}
                              onClick={() => setConfirmation({ commit, kind: 'revert' })}
                            >
                              <RotateCcw size={13} aria-hidden />
                              {t('git.revert')}
                            </button>
                          ) : commit.revertedBySha ? (
                            <span className="workspace-git-reverted">
                              {t('git.reverted', { sha: commit.revertedBySha.slice(0, 7) })}
                            </span>
                          ) : null}
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </div>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Confirm
        open={confirmation?.kind === 'initialize'}
        onOpenChange={(next) => !next && setConfirmation(null)}
        title={t('git.initializeTitle')}
        description={t('git.initializeConfirm')}
        confirmLabel={t('git.initializeConfirmLabel')}
        onConfirm={() => {
          setConfirmation(null)
          void handleInitialize()
        }}
      />
      <Confirm
        open={confirmation?.kind === 'revert'}
        onOpenChange={(next) => !next && setConfirmation(null)}
        title={t('git.revertTitle')}
        description={t('git.revertConfirm')}
        confirmLabel={t('git.revertConfirmLabel')}
        confirmKind="danger"
        onConfirm={() => {
          if (confirmation?.kind !== 'revert') return
          const commit = confirmation.commit
          setConfirmation(null)
          void handleRevert(commit)
        }}
      />
    </>
  )
}
