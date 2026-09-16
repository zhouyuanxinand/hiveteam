import { defaultSkillPackSelection } from '../shared/skill-pack-defaults.js'
import type { ResolveSkillPackInput, SkillPackRelease } from '../shared/skill-packs.js'
import type { RuntimeStore } from './runtime-store.js'
import { readWorkspaceSkillFiles } from './skill-pack-config.js'
import { SkillPackChangeError } from './skill-pack-operation-errors.js'
import { sourceUriFor } from './skill-pack-source.js'

export const DEFAULT_WORKSPACE_SKILL_PACKS = [
  {
    packName: 'matt',
    source: { type: 'github', repository: 'tt-a1i/matt-skills-with-to-goal', ref: 'main' },
    requiredSkill: 'to-goal',
  },
  {
    packName: 'code-janitor',
    source: { type: 'github', repository: 'zhouyuanxinand/code-janitor', ref: 'main' },
    requiredSkill: 'code-janitor',
  },
] satisfies Array<ResolveSkillPackInput & { requiredSkill: string }>

// Resolve before creating a database record, then apply before any agent starts.
// Imported project choices (including aliases, pinned refs and profiles) win.
export const prepareDefaultWorkspaceSkillPacks = async (store: RuntimeStore, path: string) => {
  const current = await readWorkspaceSkillFiles(path)
  const missing = DEFAULT_WORKSPACE_SKILL_PACKS.filter((input) => {
    const existing = current.configuration.packs.find(
      (pack) => sourceUriFor(pack.source) === sourceUriFor(input.source)
    )
    if (existing) {
      if (!current.lock.packs.some((pack) => pack.name === existing.name)) {
        throw new SkillPackChangeError(
          'release_unavailable',
          `Missing lock for Pack: ${existing.name}`
        )
      }
      return false
    }
    if (current.configuration.packs.some((pack) => pack.name === input.packName)) {
      throw new SkillPackChangeError(
        'invalid_intent',
        `Pack name "${input.packName}" is already used by another source`
      )
    }
    return true
  })
  const releases: SkillPackRelease[] = []
  for (const { requiredSkill, ...input } of missing) {
    const release = await store.skills.resolvePack(input, { preferCached: true })
    if (!release.manifest.skills.some((skill) => skill.name === requiredSkill)) {
      throw new SkillPackChangeError(
        'release_unavailable',
        `Default Pack ${input.packName} does not contain ${requiredSkill}`
      )
    }
    releases.push(release)
  }
  return async (workspaceId: string) => {
    const receipts: string[] = []
    try {
      for (const release of releases) {
        const plan = await store.skills.plan(workspaceId, {
          action: 'bind',
          packName: release.packName,
          releaseId: release.id,
          ...defaultSkillPackSelection(release.manifest),
        })
        const receipt = await store.skills.applyPlan(workspaceId, plan.id)
        receipts.push(receipt.id)
      }
    } catch (error) {
      if (error instanceof SkillPackChangeError && error.code === 'recovery_required') throw error
      try {
        for (const receiptId of receipts.reverse()) {
          await store.skills.undoReceipt(workspaceId, receiptId)
        }
      } catch (rollbackError) {
        throw new SkillPackChangeError(
          'recovery_required',
          `Default Skill Pack initialization failed: ${String(error)}; rollback failed: ${String(rollbackError)}`
        )
      }
      throw error
    }
  }
}
