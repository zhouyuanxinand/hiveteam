import Database from 'better-sqlite3'
import { describe, expect, test, vi } from 'vitest'
import { createSkillPackReleaseStore } from '../../src/server/skill-pack-release-store.js'
import { applySchemaVersion35 } from '../../src/server/sqlite-schema-v35.js'
import type { SkillPackManifest, SkillPackSource } from '../../src/shared/skill-packs.js'

const manifest: SkillPackManifest = {
  executablePaths: [],
  fileCount: 1,
  skills: [
    {
      containsScripts: false,
      contentDigest: `sha256:${'a'.repeat(64)}`,
      description: 'Create a verifiable goal.',
      explicitOnly: true,
      fileCount: 1,
      instructionDigest: `sha256:${'b'.repeat(64)}`,
      name: 'to-goal',
      relativePath: 'skills/to-goal',
      scriptPaths: [],
      totalBytes: 128,
    },
  ],
  totalBytes: 128,
}

const saveRelease = (
  store: ReturnType<typeof createSkillPackReleaseStore>,
  source: SkillPackSource
) =>
  store.save(
    {
      cacheKey: 'cache-key',
      contentDigest: `sha256:${'c'.repeat(64)}`,
      manifest,
      resolvedRevision: 'd'.repeat(40),
      source,
      sourceDirty: false,
      sourceUri: 'https://github.com/tt-a1i/matt-skills-with-to-goal.git',
    },
    'matt'
  )

describe('Skill Pack release store', () => {
  test('latest cache selection respects source refs and insertion order for equal timestamps', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
    const db = new Database(':memory:')
    applySchemaVersion35(db)
    const store = createSkillPackReleaseStore(db)
    const source = {
      type: 'github',
      repository: 'tt-a1i/matt-skills-with-to-goal',
      ref: 'main',
    } as const
    try {
      const first = saveRelease(store, source)
      const second = store.save(
        { ...first, contentDigest: `sha256:${'e'.repeat(64)}`, resolvedRevision: 'f'.repeat(40) },
        'matt'
      )
      const tag = saveRelease(store, { ...source, ref: 'v1' })
      const reloaded = createSkillPackReleaseStore(db)
      expect(reloaded.findLatest(source, 'alias')?.id).toBe(second.id)
      expect(reloaded.findLatest(source, 'alias')?.packName).toBe('alias')
      expect(reloaded.findLatest({ ...source, ref: 'v1' }, 'matt')?.id).toBe(tag.id)
      expect(reloaded.findLatest({ ...source, repository: 'unrelated/skills' }, 'matt')).toBeNull()
    } finally {
      clock.mockRestore()
      db.close()
    }
  })

  test('preserves requested refs across reloads and does not collapse source aliases', () => {
    const db = new Database(':memory:')
    applySchemaVersion35(db)
    const store = createSkillPackReleaseStore(db)
    const mainSource = {
      ref: 'main',
      repository: 'tt-a1i/matt-skills-with-to-goal',
      type: 'github',
    } as const
    const tagSource = { ...mainSource, ref: 'v1.0.0' }

    const mainRelease = saveRelease(store, mainSource)
    const repeatedMainRelease = saveRelease(store, mainSource)
    const tagRelease = saveRelease(store, tagSource)
    const reloaded = createSkillPackReleaseStore(db)

    expect(repeatedMainRelease.id).toBe(mainRelease.id)
    expect(tagRelease.id).not.toBe(mainRelease.id)
    expect(reloaded.getById(mainRelease.id, 'matt')?.source).toEqual(mainSource)
    expect(reloaded.getById(tagRelease.id, 'matt')?.source).toEqual(tagSource)
    expect(db.prepare('SELECT COUNT(*) AS count FROM skill_pack_releases').get()).toEqual({
      count: 2,
    })
    db.close()
  })
})
