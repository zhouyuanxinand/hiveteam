import type { Stats } from 'node:fs'
import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { ExecutionPolicyError } from './execution-policy-error.js'

export const isSensitiveExecutionName = (name: string) =>
  /^\.env(?:\.|$)/u.test(name) ||
  /\.(?:pem|key|p12|pfx)$/iu.test(name) ||
  [
    '.ssh',
    '.aws',
    '.azure',
    '.gnupg',
    '.npmrc',
    '.netrc',
    '.pypirc',
    '.docker',
    '.kube',
    '.codex',
    '.claude',
    '.gemini',
  ].includes(name)

/** Only explicit files under the selected checkout are inspected; symlinks are never followed. */
export const readExecutionFilesystem = async (workspacePath: string) => {
  const denyPaths: string[] = []
  const directories = [workspacePath]
  let count = 0
  while (directories.length) {
    const directory = directories.pop()
    if (!directory) break
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++count > 100_000)
        throw new ExecutionPolicyError(
          'The checkout exceeds the sensitive-path inspection limit.',
          ['filesystem_inventory_limit']
        )
      const path = join(directory, entry.name)
      if (isSensitiveExecutionName(entry.name)) {
        denyPaths.push(path)
        continue
      }
      if (entry.name === '.git' || entry.isSymbolicLink()) continue
      if (entry.isDirectory()) directories.push(path)
    }
  }
  const gitReadRoots: string[] = []
  let gitDirectory: string | undefined
  let commonDirectory: string | undefined
  let worktreeRoot: string | undefined
  for (let cursor = workspacePath; ; cursor = dirname(cursor)) {
    const marker = join(cursor, '.git')
    let information: Stats | undefined
    try {
      information = await lstat(marker)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (information) {
      worktreeRoot = cursor
      if (information.isSymbolicLink())
        throw new ExecutionPolicyError('Git metadata may not be a symbolic link.', [
          'git_metadata_unverified',
        ])
      gitReadRoots.push(marker)
      gitDirectory = marker
      commonDirectory = marker
      if (information.isFile()) {
        const text = await readFile(marker, 'utf8')
        if (!text.startsWith('gitdir: '))
          throw new ExecutionPolicyError('The worktree Git pointer is invalid.', [
            'git_metadata_unverified',
          ])
        gitDirectory = await realpath(resolve(cursor, text.slice(8).trim()))
        commonDirectory = gitDirectory
        gitReadRoots.push(gitDirectory)
        try {
          commonDirectory = await realpath(
            resolve(gitDirectory, (await readFile(join(gitDirectory, 'commondir'), 'utf8')).trim())
          )
          gitReadRoots.push(commonDirectory)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
      for (const root of gitReadRoots) {
        if (root === marker && information.isFile()) continue
        for (const name of ['config', 'config.worktree', 'hooks']) {
          const path = join(root, name)
          try {
            await lstat(path)
            denyPaths.push(path)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
        }
      }
      const config = await readFile(join(commonDirectory, 'config'), 'utf8')
      const format = /^\s*objectformat\s*=\s*"?([^"\s#;]+)/imu.exec(config)?.[1]
      if (format && format.toLowerCase() !== 'sha1')
        throw new ExecutionPolicyError(
          'Restricted Git views currently support SHA-1 repositories only.',
          ['git_object_format_unverified']
        )
      break
    }
    if (cursor === dirname(cursor)) break
  }
  return { gitReadRoots, denyPaths, gitDirectory, commonDirectory, worktreeRoot }
}
