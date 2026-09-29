import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'

// Login jobs do not read interactive shell profiles. Preserve an explicitly
// configured PATH, then supply common user CLI locations without copying secrets.
export const createPlatformEnvironment = (
  base,
  nodeExecutable,
  { platform = process.platform, homeDir = homedir() } = {}
) => {
  const windows = platform === 'win32'
  const paths = windows ? win32 : posix
  const env = { ...base }
  const pathKeys = Object.keys(env).filter((key) =>
    windows ? key.toLowerCase() === 'path' : key === 'PATH'
  )
  const inherited = pathKeys.flatMap((key) => (env[key] ?? '').split(paths.delimiter))
  for (const key of pathKeys) delete env[key]
  const additions = [paths.dirname(nodeExecutable)]
  if (platform === 'darwin') {
    additions.push(
      '/opt/homebrew/bin',
      '/usr/local/bin',
      paths.join(homeDir, '.local', 'bin'),
      paths.join(homeDir, '.npm-global', 'bin'),
      paths.join(homeDir, 'Library', 'pnpm'),
      paths.join(homeDir, '.volta', 'bin'),
      paths.join(homeDir, '.cargo', 'bin'),
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin'
    )
  }
  const seen = new Set()
  env.PATH = [...inherited, ...additions]
    .filter((entry) => {
      if (!entry) return false
      const key = windows ? paths.normalize(entry).toLowerCase() : entry
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .join(paths.delimiter)
  return env
}
