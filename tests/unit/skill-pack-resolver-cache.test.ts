import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { expect, test } from 'vitest'
import { createSkillPackReleaseStore } from '../../src/server/skill-pack-release-store.js'
import { createSkillPackResolver } from '../../src/server/skill-pack-resolver.js'
import { applySchemaVersion35 } from '../../src/server/sqlite-schema-v35.js'

test('cached resolution coalesces requests, survives reloads, and explicit resolution still detects source updates', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hive-resolver-cache-'))
  const db = new Database(':memory:')
  applySchemaVersion35(db)
  const releaseStore = createSkillPackReleaseStore(db)
  const cacheRoot = join(root, 'cache')
  const resolver = createSkillPackResolver({ cacheRoot, releaseStore })
  const source = join(root, 'source')
  const skillPath = join(source, 'to-goal', 'SKILL.md')
  mkdirSync(join(source, 'to-goal'), { recursive: true })
  const write = (body: string) =>
    writeFileSync(skillPath, `---\nname: to-goal\ndescription: Goal skill\n---\n${body}`)
  write('First')
  const input = { packName: 'matt', source: { type: 'local' as const, path: source } }
  try {
    const releases = await Promise.all(
      Array.from({ length: 4 }, () => resolver.resolve(input, { preferCached: true }))
    )
    expect(new Set(releases.map((release) => release.id)).size).toBe(1)
    const original = releases[0]
    write('Second')
    const reloaded = createSkillPackResolver({
      cacheRoot,
      releaseStore: createSkillPackReleaseStore(db),
    })
    expect((await reloaded.resolve(input, { preferCached: true })).id).toBe(original?.id)
    const updated = await reloaded.resolve(input)
    expect(updated.contentDigest).not.toBe(original?.contentDigest)
    expect((await reloaded.resolve(input, { preferCached: true })).id).toBe(updated.id)
  } finally {
    db.close()
    rmSync(root, { force: true, recursive: true, maxRetries: 5, retryDelay: 100 })
  }
})
