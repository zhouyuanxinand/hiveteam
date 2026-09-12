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

const recommendedProfiles: Record<SkillProfileName, Set<string>> = {
  coder: new Set(['implement', 'tdd', 'diagnosing-bugs', 'codebase-design']),
  custom: new Set(),
  orchestrator: new Set([
    'ask-matt',
    'grilling',
    'to-spec',
    'to-tickets',
    'to-goal',
    'goal-crafter',
    'wayfinder',
  ]),
  reviewer: new Set(['code-review', 'domain-modeling', 'resolving-merge-conflicts']),
  tester: new Set(['tdd', 'diagnosing-bugs', 'research']),
}

const nativeDefaults = new Set(['to-goal', 'to-spec', 'to-tickets'])

export const createDefaultSkillPackSourceDraft = (): SkillPackSourceDraft => ({
  packName: 'matt',
  sourceRef: 'main',
  sourceType: 'github',
  sourceValue: 'tt-a1i/matt-skills-with-to-goal',
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
  const profiles = Object.fromEntries(
    skillProfileNames.map((profile) => {
      const existing = configuration.profiles[profile]
        .filter((reference) => reference.startsWith(prefix))
        .map((reference) => reference.slice(prefix.length))
        .filter((name) => availableSkillNames.has(name))
      const selected =
        action === 'update'
          ? existing
          : release.manifest.skills
              .filter((skill) => recommendedProfiles[profile].has(skill.name))
              .map((skill) => skill.name)
      return [profile, new Set(selected)]
    })
  ) as Record<SkillProfileName, Set<string>>
  const existingNative = configuration.nativeExposure
    .filter((reference) => reference.startsWith(prefix))
    .map((reference) => reference.slice(prefix.length))
    .filter((name) => availableSkillNames.has(name))
  return {
    nativeExposure: new Set(
      action === 'update'
        ? existingNative
        : release.manifest.skills
            .filter((skill) => nativeDefaults.has(skill.name))
            .map((skill) => skill.name)
    ),
    profiles,
  }
}

export const shortSkillDigest = (value: string) => value.replace(/^sha256:/u, '').slice(0, 12)
