import * as Dialog from '@radix-ui/react-dialog'
import {
  AlertTriangle,
  CheckCircle2,
  CircleHelp,
  FolderSearch,
  History,
  Package,
  RefreshCw,
  Terminal,
  Users,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import type {
  SkillMemberInspection,
  WorkspaceSkillInspection,
  WorkspaceSkillPackLockEntry,
} from '../../src/shared/skill-packs.js'
import { type TranslationKey, useI18n } from './i18n.js'
import { SkillPackChangesTab } from './SkillPackChangesTab.js'
import { SkillPackPacksTab } from './SkillPackPacksTab.js'
import { getWorkspaceSkillInspection, scanWorkspaceSkills } from './skill-pack-api.js'

export type SkillPackTab = 'packs' | 'members' | 'changes'

interface WorkspaceSkillPackDrawerProps {
  initialTab?: SkillPackTab
  onClose: () => void
  open: boolean
  workspaceId: string
}

type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string

const deliveryLabels: Record<SkillMemberInspection['deliveryStatus'], TranslationKey> = {
  failed: 'skills.delivery.failed',
  not_configured: 'skills.delivery.notConfigured',
  ready: 'skills.delivery.ready',
}

const nativeLabels: Record<SkillMemberInspection['nativeDiscoveryStatus'], TranslationKey> = {
  conflict: 'skills.native.conflict',
  prompt_only: 'skills.native.promptOnly',
  ready: 'skills.native.ready',
  restart_required: 'skills.native.restartRequired',
  unverified: 'skills.native.unverified',
}

type StatusTone = 'good' | 'muted' | 'warning'

const StatusIcon = ({ status }: { status: StatusTone }) => {
  if (status === 'good') return <CheckCircle2 size={13} aria-hidden />
  if (status === 'warning') return <AlertTriangle size={13} aria-hidden />
  return <CircleHelp size={13} aria-hidden />
}

const deliveryTone = (status: SkillMemberInspection['deliveryStatus']): StatusTone =>
  status === 'ready' ? 'good' : status === 'failed' ? 'warning' : 'muted'

const nativeTone = (status: SkillMemberInspection['nativeDiscoveryStatus']): StatusTone =>
  status === 'ready'
    ? 'good'
    : status === 'conflict' || status === 'restart_required'
      ? 'warning'
      : 'muted'

const MemberCard = ({
  lockPacks,
  member,
  profileSkillReferences,
  t,
}: {
  lockPacks: WorkspaceSkillPackLockEntry[]
  member: SkillMemberInspection
  profileSkillReferences: string[]
  t: Translate
}) => {
  const foundRoots = member.roots.filter((root) => root.status === 'found').length
  const profilePackNames = Array.from(
    new Set(profileSkillReferences.map((reference) => reference.split('/')[0]).filter(Boolean))
  )
  const lockedReleases = profilePackNames.map((packName) => {
    const pack = lockPacks.find((candidate) => candidate.name === packName)
    return pack ? `${pack.name}@${pack.resolvedRevision.slice(0, 12)}` : `${packName}@—`
  })
  return (
    <article className="skill-member-card" data-testid={`skill-member-${member.agentId}`}>
      <header className="skill-member-card__header">
        <div className="min-w-0">
          <div className="skill-member-card__identity">
            <strong>{member.name}</strong>
            <span>{t(`skills.profile.${member.profile}` as TranslationKey)}</span>
          </div>
          <p>
            <Terminal size={12} aria-hidden />
            {member.commandPresetId ?? t('skills.customCommand')}
          </p>
          <p className="skill-member-card__release">
            <Package size={12} aria-hidden />
            <span>{t('skills.lockedRelease')}</span>
            <code>{lockedReleases.length > 0 ? lockedReleases.join(', ') : '—'}</code>
          </p>
        </div>
        <span className={`skill-scan-state skill-scan-state--${member.scanStatus}`}>
          {t(`skills.scan.${member.scanStatus}` as TranslationKey)}
        </span>
      </header>

      <div className="skill-readiness-grid">
        <div>
          <span>{t('skills.delivery')}</span>
          <strong data-tone={deliveryTone(member.deliveryStatus)}>
            <StatusIcon status={deliveryTone(member.deliveryStatus)} />
            {t(deliveryLabels[member.deliveryStatus])}
          </strong>
        </div>
        <div>
          <span>{t('skills.nativeDiscovery')}</span>
          <strong data-tone={nativeTone(member.nativeDiscoveryStatus)}>
            <StatusIcon status={nativeTone(member.nativeDiscoveryStatus)} />
            {t(nativeLabels[member.nativeDiscoveryStatus])}
          </strong>
        </div>
      </div>

      {member.error ? (
        <div className="skill-member-error" role="alert">
          {member.error}
        </div>
      ) : null}

      <details className="skill-member-details">
        <summary>
          <span>
            {t('skills.effectiveCount', { count: member.skills.length })}
            {' · '}
            {t('skills.rootCount', { count: foundRoots })}
          </span>
          <span>{t('skills.inspect')}</span>
        </summary>

        <section className="skill-root-list" aria-label={t('skills.roots')}>
          {member.roots.map((root) => (
            <div className="skill-root-row" key={root.id} data-status={root.status}>
              <FolderSearch size={13} aria-hidden />
              <div className="min-w-0">
                <strong>{root.label}</strong>
                <code title={root.path}>{root.path}</code>
              </div>
              <span>{t(`skills.root.${root.status}` as TranslationKey)}</span>
            </div>
          ))}
        </section>

        {member.skills.length === 0 ? (
          <p className="skill-member-empty">{t('skills.noEffectiveSkills')}</p>
        ) : (
          <section className="effective-skill-list" aria-label={t('skills.effectiveSkills')}>
            {member.skills.map((skill) => (
              <article
                className="effective-skill-row"
                data-conflict={skill.conflict ? 'true' : undefined}
                data-invalid={skill.validationErrors.length > 0 ? 'true' : undefined}
                key={`${skill.name}:${skill.canonicalPath}`}
              >
                <div className="effective-skill-row__topline">
                  <strong>${skill.name}</strong>
                  <div>
                    {skill.explicitOnly ? <span>{t('skills.explicitOnly')}</span> : null}
                    {skill.containsScripts ? <span>{t('skills.hasScripts')}</span> : null}
                    {skill.conflict ? <span>{t('skills.conflict')}</span> : null}
                    {skill.validationErrors.length > 0 ? <span>{t('skills.invalid')}</span> : null}
                  </div>
                </div>
                {skill.description ? <p>{skill.description}</p> : null}
                <code title={skill.canonicalPath}>{skill.canonicalPath}</code>
                <div className="effective-skill-row__scopes">
                  {skill.sourceScopes.map((scope) => (
                    <span key={scope}>{t(`skills.scope.${scope}` as TranslationKey)}</span>
                  ))}
                  {skill.instructionDigest ? (
                    <code>{skill.instructionDigest.slice(0, 19)}…</code>
                  ) : null}
                </div>
                {skill.validationErrors.length > 0 ? (
                  <p className="effective-skill-row__errors">{skill.validationErrors.join(', ')}</p>
                ) : null}
              </article>
            ))}
          </section>
        )}
      </details>
    </article>
  )
}

export const WorkspaceSkillPackDrawer = ({
  initialTab = 'members',
  onClose,
  open,
  workspaceId,
}: WorkspaceSkillPackDrawerProps) => {
  const { language, t } = useI18n()
  const [tab, setTab] = useState<SkillPackTab>(initialTab)
  const [inspection, setInspection] = useState<WorkspaceSkillInspection | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-US', {
        dateStyle: 'medium',
        timeStyle: 'short',
      }),
    [language]
  )

  const load = useCallback(
    async (forceScan = false) => {
      setLoading(true)
      setError(null)
      try {
        setInspection(
          forceScan
            ? await scanWorkspaceSkills(workspaceId)
            : await getWorkspaceSkillInspection(workspaceId)
        )
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : String(loadError))
      } finally {
        setLoading(false)
      }
    },
    [workspaceId]
  )

  useEffect(() => {
    if (!open) return
    setTab(initialTab)
    setInspection(null)
    void load()
  }, [initialTab, load, open])

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="app-overlay workspace-knowledge-overlay fixed inset-0 z-40" />
        <Dialog.Content
          className="workspace-knowledge-drawer workspace-skill-drawer fixed z-50 flex flex-col border-l"
          data-testid="workspace-skill-pack-drawer"
        >
          <header className="workspace-knowledge-header">
            <div className="flex min-w-0 items-center gap-3">
              <div className="skill-drawer-heading-icon" aria-hidden>
                <Package size={18} />
              </div>
              <div className="min-w-0">
                <Dialog.Title className="text-lg font-semibold text-pri">
                  {t('skills.title')}
                </Dialog.Title>
                <Dialog.Description className="mt-0.5 text-xs text-ter">
                  {t('skills.description')}
                </Dialog.Description>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                className="workspace-knowledge-close"
                onClick={() => void load(true)}
                disabled={loading}
                aria-label={t('skills.refresh')}
                title={t('skills.refresh')}
              >
                <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} aria-hidden />
              </button>
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="workspace-knowledge-close"
                  aria-label={t('common.close')}
                >
                  <X size={16} aria-hidden />
                </button>
              </Dialog.Close>
            </div>
          </header>

          <div className="skill-drawer-toolbar">
            <div className="workspace-knowledge-tabs" role="tablist" aria-label={t('skills.tabs')}>
              {(
                [
                  ['packs', Package, 'skills.tab.packs'],
                  ['members', Users, 'skills.tab.members'],
                  ['changes', History, 'skills.tab.changes'],
                ] as const
              ).map(([id, Icon, label]) => (
                <button
                  type="button"
                  key={id}
                  role="tab"
                  aria-selected={tab === id}
                  data-active={tab === id ? 'true' : undefined}
                  onClick={() => setTab(id)}
                >
                  <Icon size={13} aria-hidden />
                  {t(label)}
                </button>
              ))}
            </div>
            {inspection ? (
              <div className="skill-inspection-summary" aria-live="polite">
                <span>
                  {t('skills.summary', { count: inspection.summary.effectiveSkillCount })}
                </span>
                {inspection.summary.conflictCount > 0 ? (
                  <strong>
                    <AlertTriangle size={12} aria-hidden />
                    {t('skills.conflictCount', { count: inspection.summary.conflictCount })}
                  </strong>
                ) : null}
                <time dateTime={new Date(inspection.scannedAt).toISOString()}>
                  {dateFormatter.format(inspection.scannedAt)}
                </time>
              </div>
            ) : null}
          </div>

          {error ? (
            <div className="workspace-knowledge-error" role="alert">
              {error}
            </div>
          ) : null}

          <div className="workspace-knowledge-body skill-drawer-body scroll-y" role="tabpanel">
            {loading && !inspection ? (
              <div className="workspace-knowledge-state">
                <RefreshCw size={22} className="animate-spin" aria-hidden />
                {t('skills.scanning')}
              </div>
            ) : tab === 'packs' && inspection ? (
              <SkillPackPacksTab
                inspection={inspection}
                onChanged={() => load(true)}
                workspaceId={workspaceId}
              />
            ) : tab === 'changes' && inspection ? (
              <SkillPackChangesTab
                inspection={inspection}
                onChanged={() => load(true)}
                workspaceId={workspaceId}
              />
            ) : inspection ? (
              <div className="skill-member-list">
                <p className="skill-delivery-evidence-note">
                  <CircleHelp size={13} aria-hidden />
                  {t('skills.deliveryEvidenceHint')}
                </p>
                {inspection.members.map((member) => (
                  <MemberCard
                    key={member.agentId}
                    lockPacks={inspection.lock.packs}
                    member={member}
                    profileSkillReferences={inspection.configuration.profiles[member.profile]}
                    t={t}
                  />
                ))}
              </div>
            ) : error ? null : (
              <div className="workspace-knowledge-state">{t('skills.scanning')}</div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
