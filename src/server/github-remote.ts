import { GitCommandError, runGit } from './git-command.js'
import { ConflictError } from './http-errors.js'

export const parseGitHubRemote = (remote: string): string | null => {
  const match =
    /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/iu.exec(
      remote
    )
  return match?.[1] ?? null
}
const values = async (cwd: string, key: string) => {
  try {
    return (await runGit(cwd, ['config', '--get-all', key])).trim().split(/\r?\n/u)
  } catch (error) {
    if (error instanceof GitCommandError && error.exitCode === 1) return []
    throw error
  }
}
export const readGitHubRepository = async (cwd: string) => {
  const remotes = await values(cwd, 'remote.origin.url')
  if (!remotes.length) return null
  const repository = remotes.length === 1 ? parseGitHubRemote(remotes[0] ?? '') : null
  if (!repository) return null
  const pushes = await values(cwd, 'remote.origin.pushurl')
  if (
    pushes.length > 1 ||
    pushes.some((remote) => parseGitHubRemote(remote)?.toLowerCase() !== repository.toLowerCase())
  )
    throw new ConflictError(
      'Origin has a different or multiple push destinations. Use a single GitHub repository.'
    )
  return repository
}
