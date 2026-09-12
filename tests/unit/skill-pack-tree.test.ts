import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { inspectGitSkillPackTree } from '../../src/server/skill-pack-git-tree.js'
import {
  inspectCachedSkillPackTree,
  inspectSkillPackTree,
} from '../../src/server/skill-pack-tree.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { force: true, recursive: true })
})

const createPack = () => {
  const root = mkdtempSync(join(tmpdir(), 'hive-pack-tree-'))
  tempDirs.push(root)
  const skillPath = join(root, 'skills', 'alpha')
  mkdirSync(skillPath, { recursive: true })
  writeFileSync(
    join(skillPath, 'SKILL.md'),
    '---\nname: alpha\ndescription: Alpha Skill.\n---\nInstructions.'
  )
  writeFileSync(join(skillPath, 'reference.md'), 'Reference A')
  return root
}

describe('Skill Pack tree inspection', () => {
  test('produces a stable full-tree digest and changes it when a referenced file changes', async () => {
    const root = createPack()
    const first = await inspectSkillPackTree(root)
    const second = await inspectSkillPackTree(root)

    expect(second).toEqual(first)
    expect(first.manifest.skills[0]).toMatchObject({
      contentDigest: expect.stringMatching(/^sha256:/u),
      fileCount: 2,
      name: 'alpha',
      relativePath: 'skills/alpha',
    })

    writeFileSync(join(root, 'skills', 'alpha', 'reference.md'), 'Reference B')
    const changed = await inspectSkillPackTree(root)
    expect(changed.contentDigest).not.toBe(first.contentDigest)
    expect(changed.manifest.skills[0]?.instructionDigest).toBe(
      first.manifest.skills[0]?.instructionDigest
    )
  })

  test('blocks duplicate declared names before a release is published', async () => {
    const root = createPack()
    const duplicate = join(root, 'skills', 'second')
    mkdirSync(duplicate, { recursive: true })
    writeFileSync(
      join(duplicate, 'SKILL.md'),
      '---\nname: alpha\ndescription: Duplicate Alpha.\n---\n'
    )

    await expect(inspectSkillPackTree(root)).rejects.toMatchObject({
      code: 'duplicate_skill_name',
    })
  })

  test('rejects a binary SKILL.md before a release is published', async () => {
    const root = createPack()
    writeFileSync(
      join(root, 'skills', 'alpha', 'SKILL.md'),
      Buffer.from('---\nname: alpha\ndescription: Alpha Skill.\n---\nBinary\0instructions', 'utf8')
    )

    await expect(inspectSkillPackTree(root)).rejects.toMatchObject({ code: 'invalid_skill' })

    writeFileSync(
      join(root, 'skills', 'alpha', 'SKILL.md'),
      Buffer.concat([
        Buffer.from('---\nname: alpha\ndescription: Alpha Skill.\n---\n', 'utf8'),
        Buffer.from([0xff, 0xfe]),
      ])
    )

    await expect(inspectSkillPackTree(root)).rejects.toMatchObject({ code: 'invalid_skill' })
  })

  test('uses Git tree executable mode for digest and script inventory on every host', async () => {
    const root = createPack()
    writeFileSync(join(root, 'skills', 'alpha', 'run'), '#!/bin/sh\necho safe\n')
    const treeEntry = (mode: '100644' | '100755') =>
      [
        `100644 blob ${'a'.repeat(40)}\tskills/alpha/SKILL.md`,
        `100644 blob ${'b'.repeat(40)}\tskills/alpha/reference.md`,
        `${mode} blob ${'c'.repeat(40)}\tskills/alpha/run`,
        '',
      ].join('\0')

    const regular = await inspectGitSkillPackTree(root, treeEntry('100644'))
    const executable = await inspectGitSkillPackTree(root, treeEntry('100755'))
    if (process.platform !== 'win32') chmodSync(join(root, 'skills', 'alpha', 'run'), 0o755)
    const cached = await inspectCachedSkillPackTree(root, executable.manifest)

    expect(executable.contentDigest).not.toBe(regular.contentDigest)
    expect(cached).toEqual(executable)
    expect(regular.manifest.skills[0]?.scriptPaths).toEqual([])
    expect(executable.manifest).toMatchObject({
      executablePaths: ['skills/alpha/run'],
      skills: [{ containsScripts: true, scriptPaths: ['skills/alpha/run'] }],
    })
  })

  test('materializes safe file symlinks and rejects escaping symlinks and gitlinks', async () => {
    const root = createPack()
    writeFileSync(join(root, 'CLAUDE.md'), 'Shared agent guidance.\n')
    writeFileSync(join(root, 'AGENTS.md'), 'CLAUDE.md')
    const regularEntries = [
      `100644 blob ${'a'.repeat(40)}\tCLAUDE.md`,
      `100644 blob ${'b'.repeat(40)}\tskills/alpha/SKILL.md`,
      `100644 blob ${'c'.repeat(40)}\tskills/alpha/reference.md`,
    ]
    const treeWith = (entry: string) => [...regularEntries, entry, ''].join('\0')

    const inspected = await inspectGitSkillPackTree(
      root,
      treeWith(`120000 blob ${'d'.repeat(40)}\tAGENTS.md`),
      async (objectId) => {
        expect(objectId).toBe('d'.repeat(40))
        return 'CLAUDE.md'
      }
    )

    expect(inspected.manifest.fileCount).toBe(4)
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe('Shared agent guidance.\n')

    await expect(
      inspectGitSkillPackTree(
        root,
        treeWith(`120000 blob ${'e'.repeat(40)}\tAGENTS.md`),
        async () => '../outside.md'
      )
    ).rejects.toMatchObject({ code: 'source_path_unsafe' })
    await expect(
      inspectGitSkillPackTree(
        root,
        treeWith(`120000 blob ${'e'.repeat(40)}\tAGENTS.md`),
        async () => 'C:/outside.md'
      )
    ).rejects.toMatchObject({ code: 'source_path_unsafe' })
    await expect(
      inspectGitSkillPackTree(
        root,
        [
          ...regularEntries,
          `120000 blob ${'d'.repeat(40)}\tAGENTS.md`,
          `120000 blob ${'e'.repeat(40)}\tGUIDE.md`,
          '',
        ].join('\0'),
        async (objectId) => (objectId === 'd'.repeat(40) ? 'GUIDE.md' : 'CLAUDE.md')
      )
    ).rejects.toMatchObject({ code: 'source_path_unsafe' })
    await expect(
      inspectGitSkillPackTree(
        root,
        treeWith(`160000 commit ${'f'.repeat(40)}\tvendor`),
        async () => ''
      )
    ).rejects.toMatchObject({ code: 'source_path_unsafe' })
  })

  test.skipIf(process.platform === 'win32')(
    'includes executable mode in release identity and blocks executable streaming',
    async () => {
      const root = createPack()
      const executablePath = join(root, 'skills', 'alpha', 'run')
      writeFileSync(executablePath, '#!/bin/sh\necho unsafe\n')
      chmodSync(executablePath, 0o644)
      const before = await inspectSkillPackTree(root)

      chmodSync(executablePath, 0o755)
      const inspected = await inspectSkillPackTree(root)

      expect(inspected.contentDigest).not.toBe(before.contentDigest)
      expect(inspected.manifest.skills[0]?.contentDigest).not.toBe(
        before.manifest.skills[0]?.contentDigest
      )
      expect(inspected.manifest.skills[0]).toMatchObject({
        containsScripts: true,
        scriptPaths: ['skills/alpha/run'],
      })
    }
  )
})
