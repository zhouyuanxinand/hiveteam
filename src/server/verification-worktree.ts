import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { detectGitRepository, GitCommandError, runGit } from './git-command.js'
import { readMergeState } from './git-merge-state.js'

export const readVerificationVersion = async (workspacePath: string) => {
  try {
    const repository = await detectGitRepository(workspacePath)
    const changes = await runGit(repository.repoRoot, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
    ])
    // Hive writes these two untracked coordination files when opening a workspace.
    // Tracked edits, including tracked .hive files, still invalidate verification.
    const prefix = repository.relativePath ? `${repository.relativePath}/` : ''
    const metadata = new Set([`?? ${prefix}.hive/tasks.md`, `?? ${prefix}.hive/PROTOCOL.md`])
    const isDirty = changes.split('\0').some((entry) => entry.length > 0 && !metadata.has(entry))
    const operation = await readMergeState(repository.repoRoot)
    return {
      ...repository,
      isDirty,
      unavailableReason: operation
        ? 'Finish or abort the Git operation in this directory before verifying.'
        : null,
    }
  } catch (error) {
    if (!(error instanceof GitCommandError)) throw error
    return {
      repoRoot: null,
      relativePath: null,
      headSha: null,
      isDirty: false,
      unavailableReason: error.message,
    }
  }
}

/** Owns only a temporary checkout; never changes the source branch or index. */
export const withVerificationWorktree = async <T>(input: {
  dataDir: string | null
  repoRoot: string
  relativePath: string | null
  headSha: string
  run: (cwd: string, checkout: string) => Promise<T>
}): Promise<T> => {
  const root = resolve(input.dataDir ?? tmpdir(), 'verification-worktrees')
  await mkdir(root, { recursive: true })
  const rootReal = await realpath(root)
  const container = await mkdtemp(join(rootReal, 'check-'))
  const checkout = join(container, 'checkout')
  const hooks = join(container, 'empty-hooks')
  await mkdir(hooks)
  let registered = false
  const cleanup = async () => {
    // Check resolved ownership before recursive removal, including on Windows.
    if (!(await realpath(container)).startsWith(`${rootReal}${sep}`))
      throw new Error('Verification cleanup path is outside its runtime directory')
    if (registered) {
      if ((await realpath(checkout)) !== checkout)
        throw new Error('Verification checkout moved; cleanup was stopped')
      await runGit(input.repoRoot, ['worktree', 'remove', '--force', checkout], { timeout: 60_000 })
    }
    await rm(container, { recursive: true, force: true, maxRetries: 3 })
  }
  let result: T
  try {
    await runGit(
      input.repoRoot,
      ['-c', `core.hooksPath=${hooks}`, 'worktree', 'add', '--detach', checkout, input.headSha],
      { timeout: 60_000 }
    )
    registered = true
    const cwd = resolve(checkout, input.relativePath ?? '.')
    if (cwd !== checkout && !cwd.startsWith(`${checkout}${sep}`))
      throw new Error('Workspace is outside the verification checkout')
    result = await input.run(cwd, checkout)
  } catch (error) {
    try {
      await cleanup()
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Verification and checkout cleanup both failed',
        { cause: error }
      )
    }
    throw error
  }
  await cleanup()
  return result
}
