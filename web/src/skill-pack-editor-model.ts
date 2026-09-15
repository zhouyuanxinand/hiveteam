import { defaultSkillPackSelection } from '../../src/shared/skill-pack-defaults.js'
import { describeSkillPackSource } from '../../src/shared/skill-pack-source.js'
import type {
  SkillPackRelease,
  SkillPackSource,
  SkillProfileName,
  WorkspaceSkillPackConfiguration,
} from '../../src/shared/skill-packs.js'
import { skillProfileNames } from '../../src/shared/skill-packs.js'

export type SkillPackEditorAction = 'bind' | 'update'
export type SkillPackEditorBusy = 'apply' | 'plan' | 'remove' | 'resolve' | null

export interface SkillPackSourceDraft {
  packName: string
  sourceRef: string
  sourceType: SkillPackSource['type']
  sourceValue: string
}

export interface SkillPackSelection {
  nativeExposure: Set<string>
  profiles: Record<SkillProfileName, Set<string>>
}

export const createDefaultSkillPackSourceDraft = (): SkillPackSourceDraft => ({
  packName: '',
  sourceRef: 'main',
  sourceType: 'github',
  sourceValue: '',
})

export const createEmptySkillPackSelection = (): SkillPackSelection => ({
  nativeExposure: new Set(),
  profiles: Object.fromEntries(skillProfileNames.map((profile) => [profile, new Set()])) as Record<
    SkillProfileName,
    Set<string>
  >,
})

export const describeSkillPackSourceDraft = (
  packName: string,
  source: SkillPackSource,
  fallbackRef: string
): SkillPackSourceDraft => {
  const description = describeSkillPackSource(source)
  return {
    packName,
    sourceRef: description.ref ?? fallbackRef,
    sourceType: source.type,
    sourceValue: description.inputValue,
  }
}

export const skillPackSourceFromDraft = (draft: SkillPackSourceDraft): SkillPackSource => {
  if (draft.sourceType === 'github') {
    return { ref: draft.sourceRef, repository: draft.sourceValue, type: 'github' }
  }
  if (draft.sourceType === 'git') {
    return { ref: draft.sourceRef, type: 'git', url: draft.sourceValue }
  }
  return { path: draft.sourceValue, type: 'local' }
}

export const selectSkillsForRelease = (
  release: SkillPackRelease,
  action: SkillPackEditorAction,
  configuration: WorkspaceSkillPackConfiguration
): SkillPackSelection => {
  const prefix = `${release.packName}/`
  const availableSkillNames = new Set(release.manifest.skills.map((skill) => skill.name))
  const defaults = defaultSkillPackSelection(release.manifest)
  const profiles = Object.fromEntries(
    skillProfileNames.map((profile) => {
      const existing = configuration.profiles[profile]
        .filter((reference) => reference.startsWith(prefix))
        .map((reference) => reference.slice(prefix.length))
        .filter((name) => availableSkillNames.has(name))
      const selected = action === 'update' ? existing : defaults.profiles[profile]
      return [profile, new Set(selected)]
    })
  ) as Record<SkillProfileName, Set<string>>
  const existingNative = configuration.nativeExposure
    .filter((reference) => reference.startsWith(prefix))
    .map((reference) => reference.slice(prefix.length))
    .filter((name) => availableSkillNames.has(name))
  return {
    nativeExposure: new Set(action === 'update' ? existingNative : defaults.nativeExposure),
    profiles,
  }
}

export const shortSkillDigest = (value: string) => value.replace(/^sha256:/u, '').slice(0, 12)
