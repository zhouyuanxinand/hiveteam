import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { createSkillPackReleaseStore } from '../../src/server/skill-pack-release-store.js'
import { createSkillPackResolver } from '../../src/server/skill-pack-resolver.js'
import { sourceUriFor } from '../../src/server/skill-pack-source.js'
import type { SkillPackSource } from '../../src/shared/skill-packs.js'

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
    const remote = (source: SkillPackSource, revision: string) => ({
      source,
      sourceUri: sourceUriFor(source),
      resolvedRevision: revision.repeat(40),
    })
    const release = releaseStore.save(
      {
        ...local,
        ...remote(
          { type: 'github', repository: 'tt-a1i/matt-skills-with-to-goal', ref: 'main' },
          'a'
        ),
      },
      'matt'
    )
    // The real Janitor repository is a single root-level Skill, not a skills/ tree.
    const janitorPath = join(root, 'janitor-source')
    mkdirSync(join(janitorPath, 'references'), { recursive: true })
    writeFileSync(
      join(janitorPath, 'SKILL.md'),
      '---\nname: code-janitor\ndescription: Simplification audit.\n---\nFixture instructions for code-janitor.\nRead references/proof.md.\n'
    )
    writeFileSync(join(janitorPath, 'references', 'proof.md'), 'Prove consumers before deletion.\n')
    const janitorLocal = await resolver.resolve({
      packName: 'janitor-fixture',
      source: { type: 'local', path: janitorPath },
    })
    const janitorRelease = releaseStore.save(
      {
        ...janitorLocal,
        ...remote({ type: 'github', repository: 'zhouyuanxinand/code-janitor', ref: 'main' }, 'b'),
      },
      'code-janitor'
    )
    return {
      release,
      cachePath: resolver.getReleasePath(release),
      janitorRelease,
      janitorCachePath: resolver.getReleasePath(janitorRelease),
    }
  } finally {
    db.close()
  }
}
