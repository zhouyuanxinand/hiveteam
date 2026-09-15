import type { SkillPackManifest, SkillProfileName, SkillProfiles } from './skill-packs.js'
import { skillProfileNames } from './skill-packs.js'

const recommendedProfiles: Record<SkillProfileName, string[]> = {
  coder: ['implement', 'tdd', 'diagnosing-bugs', 'codebase-design'],
  custom: [],
  orchestrator: [
    'ask-matt',
    'grilling',
    'to-spec',
    'to-tickets',
    'to-goal',
    'goal-crafter',
    'wayfinder',
  ],
  reviewer: ['code-review', 'domain-modeling', 'resolving-merge-conflicts'],
  tester: ['tdd', 'diagnosing-bugs', 'research'],
}

export const defaultSkillPackSelection = (manifest: SkillPackManifest) => {
  const available = new Set(manifest.skills.map((skill) => skill.name))
  const profiles = Object.fromEntries(
    skillProfileNames.map((role) => [
      role,
      recommendedProfiles[role].filter((name) => available.has(name)),
    ])
  ) as SkillProfiles
  return {
    nativeExposure: ['to-goal', 'to-spec', 'to-tickets'].filter((name) => available.has(name)),
    profiles,
  }
}
