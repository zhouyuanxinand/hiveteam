import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { runGit } from './git-command.js'

export const readMergeState = async (cwd: string) => {
  const gitDir = (await runGit(cwd, ['rev-parse', '--absolute-git-dir'])).trim()
  return (
    ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'].find((name) =>
      existsSync(join(gitDir, name))
    ) ?? null
  )
}
export const readConflictFiles = async (cwd: string) =>
  (await runGit(cwd, ['diff', '--name-only', '--diff-filter=U', '-z'])).split('\0').filter(Boolean)
