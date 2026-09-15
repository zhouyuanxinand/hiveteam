import { defaultSkillPackSelection } from '../shared/skill-pack-defaults.js'
import type { ResolveSkillPackInput } from '../shared/skill-packs.js'
import type { RuntimeStore } from './runtime-store.js'
import { readWorkspaceSkillFiles } from './skill-pack-config.js'
import { SkillPackChangeError } from './skill-pack-operation-errors.js'
import { sourceUriFor } from './skill-pack-source.js'

export const DEFAULT_WORKSPACE_SKILL_PACK: ResolveSkillPackInput = {
  packName: 'matt',
  source: { type: 'github', repository: 'tt-a1i/matt-skills-with-to-goal', ref: 'main' },
}

// Resolve before creating a database record, then apply before any agent starts.
// Imported project choices (including aliases, pinned refs and profiles) win.
export const prepareDefaultWorkspaceSkillPack = async (store: RuntimeStore, path: string) => {
  const current = await readWorkspaceSkillFiles(path)
  const existing = current.configuration.packs.find(
    (pack) => sourceUriFor(pack.source) === sourceUriFor(DEFAULT_WORKSPACE_SKILL_PACK.source)
  )
  if (existing) {
    if (!current.lock.packs.some((pack) => pack.name === existing.name)) {
      throw new SkillPackChangeError(
        'release_unavailable',
        `Missing lock for Pack: ${existing.name}`
      )
    }
    return async (_workspaceId: string) => {}
  }
  if (
    current.configuration.packs.some((pack) => pack.name === DEFAULT_WORKSPACE_SKILL_PACK.packName)
  ) {
    throw new SkillPackChangeError(
      'invalid_intent',
      'Pack name "matt" is already used by another source'
    )
  }
  const release = await store.skills.resolvePack(DEFAULT_WORKSPACE_SKILL_PACK, {
    preferCached: true,
  })
  if (!release.manifest.skills.some((skill) => skill.name === 'to-goal')) {
    throw new SkillPackChangeError(
      'release_unavailable',
      'Default Matt Pack does not contain to-goal'
    )
  }
  return async (workspaceId: string) => {
    const plan = await store.skills.plan(workspaceId, {
      action: 'bind',
      packName: DEFAULT_WORKSPACE_SKILL_PACK.packName,
      releaseId: release.id,
      ...defaultSkillPackSelection(release.manifest),
    })
    await store.skills.applyPlan(workspaceId, plan.id)
  }
}
