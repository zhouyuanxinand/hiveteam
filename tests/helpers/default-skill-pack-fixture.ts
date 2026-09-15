import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { DEFAULT_WORKSPACE_SKILL_PACK } from '../../src/server/default-workspace-skill-pack.js'
import { createSkillPackReleaseStore } from '../../src/server/skill-pack-release-store.js'
import { createSkillPackResolver } from '../../src/server/skill-pack-resolver.js'
import { sourceUriFor } from '../../src/server/skill-pack-source.js'

// A locally authored remote-cache fixture: no network and no third-party scripts.
// Parsing, cache digests, release persistence and all binding operations are real.
export const seedDefaultSkillPackCache = async (dataDir: string, root: string) => {
  const sourcePath = join(root, 'source')
  const names = [
    'to-goal',
    'to-spec',
    'to-tickets',
    'tdd',
    'diagnosing-bugs',
    'codebase-design',
    'code-review',
    'domain-modeling',
    'resolving-merge-conflicts',
    'research',
    'ask-matt',
    'grilling',
    'goal-crafter',
    'wayfinder',
    'implement',
  ]
  for (const name of names) {
    mkdirSync(join(sourcePath, name), { recursive: true })
    writeFileSync(
      join(sourcePath, name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Use ${name}.\n---\nFixture instructions for ${name}.\n`
    )
  }
  const db = new Database(join(dataDir, 'runtime.sqlite'))
  try {
    const releaseStore = createSkillPackReleaseStore(db)
    const resolver = createSkillPackResolver({
      cacheRoot: join(dataDir, 'skill-packs'),
      releaseStore,
    })
    const local = await resolver.resolve({
      packName: 'fixture',
      source: { type: 'local', path: sourcePath },
    })
    const release = releaseStore.save(
      {
        ...local,
        source: DEFAULT_WORKSPACE_SKILL_PACK.source,
        sourceUri: sourceUriFor(DEFAULT_WORKSPACE_SKILL_PACK.source),
        resolvedRevision: 'a'.repeat(40),
      },
      'matt'
    )
    return { release, cachePath: resolver.getReleasePath(release) }
  } finally {
    db.close()
  }
}
