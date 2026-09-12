import { AlertTriangle, LoaderCircle, ShieldCheck } from 'lucide-react'
import { useMemo } from 'react'

import type {
  SkillPackRelease,
  SkillProfileName,
  WorkspaceSkillPackLockEntry,
} from '../../src/shared/skill-packs.js'
import { useI18n } from './i18n.js'
import { SkillPackAssignmentMatrix } from './SkillPackAssignmentMatrix.js'
import type { SkillPackEditorBusy, SkillPackSelection } from './skill-pack-editor-model.js'
import { shortSkillDigest } from './skill-pack-editor-model.js'

interface SkillPackReleasePreviewProps {
  busy: SkillPackEditorBusy
  currentLock: WorkspaceSkillPackLockEntry | undefined
  onReviewPlan: () => void
  onToggleNative: (skillName: string) => void
  onToggleProfile: (profile: SkillProfileName, skillName: string) => void
  release: SkillPackRelease
  selection: SkillPackSelection
}

export const SkillPackReleasePreview = ({
  busy,
  currentLock,
  onReviewPlan,
  onToggleNative,
  onToggleProfile,
  release,
  selection,
}: SkillPackReleasePreviewProps) => {
  const { t } = useI18n()
  const releaseDiff = useMemo(() => {
    const currentSkills = new Map(currentLock?.skills.map((skill) => [skill.name, skill]) ?? [])
    const nextSkills = new Map(release.manifest.skills.map((skill) => [skill.name, skill]))
    return {
      added: release.manifest.skills.filter((skill) => !currentSkills.has(skill.name)).length,
      changed: release.manifest.skills.filter((skill) => {
        const before = currentSkills.get(skill.name)
        return Boolean(before && before.contentDigest !== skill.contentDigest)
      }).length,
      removed: currentLock?.skills.filter((skill) => !nextSkills.has(skill.name)).length ?? 0,
    }
  }, [currentLock, release])
  const scriptInventory = useMemo(
    () =>
      release.manifest.skills.flatMap((skill) =>
        skill.scriptPaths.map((path) => ({ path, skillName: skill.name }))
      ),
    [release]
  )
  const selectedCount = Object.values(selection.profiles).reduce(
    (sum, selected) => sum + selected.size,
    0
  )

  return (
    <div className="skill-release-preview">
      <div className="skill-release-preview__identity">
        <div>
          <span>{t('skills.resolvedRelease')}</span>
          <strong>{release.resolvedRevision.slice(0, 16)}</strong>
        </div>
        <code>{shortSkillDigest(release.contentDigest)}</code>
      </div>
      <div className="skill-release-preview__facts">
        <span>{t('skills.skillCount', { count: release.manifest.skills.length })}</span>
        <span>{t('skills.fileCount', { count: release.manifest.fileCount })}</span>
        <span
          data-warning={release.manifest.skills.some((skill) => skill.containsScripts) || undefined}
        >
          {t('skills.scriptCount', {
            count: release.manifest.skills.reduce(
              (sum, skill) => sum + skill.scriptPaths.length,
              0
            ),
          })}
        </span>
        {releaseDiff.added ? (
          <span data-change="added">{t('skills.diffAdded', { count: releaseDiff.added })}</span>
        ) : null}
        {releaseDiff.changed ? (
          <span data-change="changed">
            {t('skills.diffChanged', { count: releaseDiff.changed })}
          </span>
        ) : null}
        {releaseDiff.removed ? (
          <span data-change="removed">
            {t('skills.diffRemoved', { count: releaseDiff.removed })}
          </span>
        ) : null}
      </div>
      {scriptInventory.length > 0 ? (
        <details className="skill-release-security">
          <summary>
            <AlertTriangle size={13} aria-hidden />
            {t('skills.scriptInventory', { count: scriptInventory.length })}
          </summary>
          <p>{t('skills.scriptSafety')}</p>
          <div className="skill-operation-list">
            {scriptInventory.map((script) => (
              <div key={`${script.skillName}:${script.path}`}>
                <span>{script.skillName}</span>
                <code title={script.path}>{script.path}</code>
              </div>
            ))}
          </div>
        </details>
      ) : null}
      <SkillPackAssignmentMatrix
        onToggleNative={onToggleNative}
        onToggleProfile={onToggleProfile}
        release={release}
        selection={selection}
      />
      <footer className="skill-editor-footer">
        <span>
          {t('skills.assignmentSummary', {
            native: selection.nativeExposure.size,
            profiles: selectedCount,
          })}
        </span>
        <button
          type="button"
          className="skill-action-button skill-action-button--primary"
          disabled={busy !== null}
          onClick={onReviewPlan}
        >
          {busy === 'plan' ? (
            <LoaderCircle className="animate-spin" size={14} />
          ) : (
            <ShieldCheck size={14} />
          )}
          {t('skills.reviewPlan')}
        </button>
      </footer>
    </div>
  )
}
