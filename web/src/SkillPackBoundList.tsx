import { AlertTriangle, Check, GitBranch, PackagePlus, RefreshCw, Trash2 } from 'lucide-react'

import { describeSkillPackSource } from '../../src/shared/skill-pack-source.js'
import type { WorkspaceSkillInspection } from '../../src/shared/skill-packs.js'
import { useI18n } from './i18n.js'
import { shortSkillDigest } from './skill-pack-editor-model.js'

interface SkillPackBoundListProps {
  busy: boolean
  inspection: WorkspaceSkillInspection
  onRemove: (name: string) => void
  onUpdate: (name: string) => void
}

export const SkillPackBoundList = ({
  busy,
  inspection,
  onRemove,
  onUpdate,
}: SkillPackBoundListProps) => {
  const { t } = useI18n()
  if (inspection.configuration.packs.length === 0) {
    return (
      <div className="skill-empty-card">
        <PackagePlus size={24} aria-hidden />
        <strong>{t('skills.noPacks')}</strong>
        <p>{t('skills.noPacksDescription')}</p>
      </div>
    )
  }

  return (
    <div className="skill-pack-list">
      {inspection.configuration.packs.map((pack) => {
        const locked = inspection.lock.packs.find((candidate) => candidate.name === pack.name)
        const source = describeSkillPackSource(pack.source)
        const lockMatchesBinding =
          locked?.sourceType === pack.source.type && locked.sourceUri === source.uri
        return (
          <article className="skill-pack-card" key={pack.name}>
            <div className="skill-pack-card__main">
              <div className="skill-pack-card__name">
                <strong>{pack.name}</strong>
                <span data-warning={!lockMatchesBinding || undefined}>
                  {lockMatchesBinding ? (
                    <Check size={11} aria-hidden />
                  ) : (
                    <AlertTriangle size={11} aria-hidden />
                  )}{' '}
                  {t(lockMatchesBinding ? 'skills.locked' : 'skills.lockDrift')}
                </span>
              </div>
              <code title={source.label}>{source.label}</code>
              <div className="skill-pack-card__facts">
                <span>
                  <GitBranch size={11} aria-hidden /> {locked?.resolvedRevision.slice(0, 12) ?? '—'}
                </span>
                <span>{locked?.skills.length ?? 0} Skills</span>
                <span>{locked ? shortSkillDigest(locked.contentDigest) : '—'}</span>
              </div>
            </div>
            <div className="skill-pack-card__actions">
              <button type="button" disabled={busy} onClick={() => onUpdate(pack.name)}>
                <RefreshCw size={12} aria-hidden /> {t('skills.checkUpdates')}
              </button>
              <button type="button" disabled={busy} onClick={() => onRemove(pack.name)}>
                <Trash2 size={12} aria-hidden /> {t('skills.remove')}
              </button>
            </div>
          </article>
        )
      })}
    </div>
  )
}
