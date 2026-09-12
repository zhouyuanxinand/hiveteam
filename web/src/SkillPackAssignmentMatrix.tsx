import type { SkillPackRelease, SkillProfileName } from '../../src/shared/skill-packs.js'
import { skillProfileNames } from '../../src/shared/skill-packs.js'
import { type TranslationKey, useI18n } from './i18n.js'
import type { SkillPackSelection } from './skill-pack-editor-model.js'

const hiveAdapterRequired = new Set(['spec-executor', 'roundtable', 'execute-spec-in-fork'])
export const MAX_NATIVE_EXPOSURE = 12

interface SkillPackAssignmentMatrixProps {
  onToggleNative: (skillName: string) => void
  onToggleProfile: (profile: SkillProfileName, skillName: string) => void
  release: SkillPackRelease
  selection: SkillPackSelection
}

export const SkillPackAssignmentMatrix = ({
  onToggleNative,
  onToggleProfile,
  release,
  selection,
}: SkillPackAssignmentMatrixProps) => {
  const { t } = useI18n()
  return (
    <fieldset className="skill-profile-matrix">
      <legend className="sr-only">{t('skills.profileAssignments')}</legend>
      <div className="skill-profile-matrix__head">
        <span>Skill</span>
        {skillProfileNames.map((profile) => (
          <span key={profile}>{t(`skills.profile.${profile}` as TranslationKey)}</span>
        ))}
        <span>{t('skills.native')}</span>
      </div>
      {release.manifest.skills.map((skill) => (
        <div className="skill-profile-matrix__row" key={skill.name}>
          <div>
            <strong>{skill.name}</strong>
            <small>{skill.description}</small>
            {skill.containsScripts ? <em>{t('skills.hasScripts')}</em> : null}
            {hiveAdapterRequired.has(skill.name) ? (
              <em>{t('skills.hiveAdapterRequired')}</em>
            ) : null}
          </div>
          {skillProfileNames.map((profile) => (
            <label key={profile} title={t(`skills.profile.${profile}` as TranslationKey)}>
              <input
                type="checkbox"
                checked={selection.profiles[profile].has(skill.name)}
                onChange={() => onToggleProfile(profile, skill.name)}
              />
              <span>{t(`skills.profile.${profile}` as TranslationKey)}</span>
            </label>
          ))}
          <label
            title={
              !selection.nativeExposure.has(skill.name) &&
              selection.nativeExposure.size >= MAX_NATIVE_EXPOSURE
                ? t('skills.nativeLimit', { count: MAX_NATIVE_EXPOSURE })
                : t('skills.native')
            }
          >
            <input
              type="checkbox"
              checked={selection.nativeExposure.has(skill.name)}
              disabled={
                !selection.nativeExposure.has(skill.name) &&
                selection.nativeExposure.size >= MAX_NATIVE_EXPOSURE
              }
              onChange={() => onToggleNative(skill.name)}
            />
            <span>{t('skills.native')}</span>
          </label>
        </div>
      ))}
    </fieldset>
  )
}
