import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import {
  detectGitRepository,
  GitCommandError,
  readGitWorkingTreeDiff,
} from '../../src/server/git-command.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

const runGit = (cwd: string, args: string[]) => {
  execFileSync('git', args, { cwd, stdio: 'ignore', windowsHide: true })
}

const createRepository = async () => {
  const repository = mkdtempSync(join(tmpdir(), 'hive-diff-reader-'))
  tempDirs.push(repository)
  runGit(repository, ['init'])
  runGit(repository, ['config', 'user.name', 'HiveTest'])
  runGit(repository, ['config', 'user.email', 'hive-test@example.test'])
  writeFileSync(join(repository, 'README.md'), '# before\n')
  runGit(repository, ['add', '-A'])
  runGit(repository, ['commit', '-m', 'initial'])
  const info = await detectGitRepository(repository)
  return { info, repository }
}

describe('readGitWorkingTreeDiff', () => {
  test('returns the patch against the baseline and lists untracked files separately', async () => {
    const { info, repository } = await createRepository()
    const baseSha = info.headSha
    expect(baseSha).toBeTruthy()

    writeFileSync(join(repository, 'README.md'), '# after\n')
    writeFileSync(join(repository, 'notes.txt'), 'untracked\n')

    const diff = await readGitWorkingTreeDiff(info, baseSha as string)
    expect(diff.truncated).toBe(false)
    expect(diff.patch).toContain('diff --git a/README.md b/README.md')
    expect(diff.patch).toContain('-# before')
    expect(diff.patch).toContain('+# after')
    // Untracked files have no baseline blob, so they are reported by name only.
    expect(diff.patch).not.toContain('notes.txt')
    expect(diff.untrackedFiles).toEqual(['notes.txt'])
  })

  test('excludes the internal .hive directory from patch and untracked files', async () => {
    const { info, repository } = await createRepository()
    const baseSha = info.headSha as string

    mkdirSync(join(repository, '.hive'), { recursive: true })
    writeFileSync(join(repository, '.hive', 'tasks.md'), '# tasks\n')
    writeFileSync(join(repository, 'src-file.ts'), 'export const x = 1\n')

    const diff = await readGitWorkingTreeDiff(info, baseSha)
    expect(diff.patch).not.toContain('.hive')
    expect(diff.untrackedFiles).toEqual(['src-file.ts'])
  })

  test('truncates oversized patches and flags them', async () => {
    const { info, repository } = await createRepository()
    const baseSha = info.headSha as string

    writeFileSync(join(repository, 'README.md'), `# after\n${'line\n'.repeat(200)}`)

    const diff = await readGitWorkingTreeDiff(info, baseSha, { maxChars: 1024 })
    expect(diff.truncated).toBe(true)
    expect(diff.patch.length).toBeLessThanOrEqual(1025)
  })

  test('rejects a malformed baseline sha before running git', async () => {
    const { info } = await createRepository()
    await expect(readGitWorkingTreeDiff(info, 'not-a-sha')).rejects.toBeInstanceOf(GitCommandError)
  })
})
