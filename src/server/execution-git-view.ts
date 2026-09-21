import { lstat, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Git reads use live, read-only metadata without repository hooks, filters or credentials. */
export const createExecutionGitView = async (input: {
  viewPath: string
  gitDirectory: string
  commonDirectory: string
  workspacePath: string
}) => {
  await mkdir(input.viewPath, { recursive: true, mode: 0o700 })
  await writeFile(
    join(input.viewPath, 'config'),
    '[core]\nrepositoryformatversion = 0\nbare = false\n',
    { mode: 0o600, flag: 'wx' }
  )
  await writeFile(join(input.viewPath, 'HEAD'), await readFile(join(input.gitDirectory, 'HEAD')), {
    mode: 0o600,
    flag: 'wx',
  })
  for (const [name, root] of [
    ['index', input.gitDirectory],
    ['refs', input.commonDirectory],
    ['objects', input.commonDirectory],
    ['packed-refs', input.commonDirectory],
    ['shallow', input.commonDirectory],
  ] as const) {
    const source = join(root, name)
    try {
      await lstat(source)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    await symlink(source, join(input.viewPath, name))
  }
  return {
    GIT_DIR: input.viewPath,
    GIT_COMMON_DIR: input.viewPath,
    GIT_WORK_TREE: input.workspacePath,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  }
}
