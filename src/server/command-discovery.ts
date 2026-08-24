import { type Dirent, readdirSync } from 'node:fs'
import { join } from 'node:path'

const getEnvValue = (env: NodeJS.ProcessEnv, key: string): string | undefined => {
  const matchedKey = Object.keys(env).find((item) => item.toLowerCase() === key.toLowerCase())
  return matchedKey ? env[matchedKey] : undefined
}

const uniquePaths = (paths: Array<string | undefined>) => {
  const seen = new Set<string>()
  return paths.filter((path): path is string => {
    if (!path) return false
    const normalized = path.replaceAll('/', '\\').toLowerCase()
    if (seen.has(normalized)) return false
    seen.add(normalized)
    return true
  })
}

const getWindowsCliSearchRoots = (env: NodeJS.ProcessEnv): string[] => {
  const appData = getEnvValue(env, 'APPDATA')
  const localAppData = getEnvValue(env, 'LOCALAPPDATA')
  const userProfile = getEnvValue(env, 'USERPROFILE')
  const programFiles = getEnvValue(env, 'ProgramFiles')
  const programFilesX86 = getEnvValue(env, 'ProgramFiles(x86)')
  const programData = getEnvValue(env, 'ProgramData')

  return uniquePaths([
    appData ? join(appData, 'npm') : undefined,
    appData ? join(appData, 'pnpm') : undefined,
    localAppData ? join(localAppData, 'pnpm') : undefined,
    localAppData ? join(localAppData, 'Programs') : undefined,
    userProfile ? join(userProfile, '.bun', 'bin') : undefined,
    userProfile ? join(userProfile, '.npm-global', 'bin') : undefined,
    userProfile ? join(userProfile, 'scoop', 'shims') : undefined,
    programData ? join(programData, 'chocolatey', 'bin') : undefined,
    programFiles ? join(programFiles, 'nodejs') : undefined,
    programFiles ? join(programFiles, 'scoop', 'shims') : undefined,
    programFilesX86 ? join(programFilesX86, 'nodejs') : undefined,
  ])
}

type DiscoveryIndex = Map<string, string>

const executablePriority = (name: string) => {
  const extension = name.slice(name.lastIndexOf('.')).toLowerCase()
  if (extension === '.cmd') return 0
  if (extension === '.bat') return 1
  return 2
}

const scanRoot = (root: string, maxDepth: number, index: DiscoveryIndex) => {
  const queue: Array<{ depth: number; path: string }> = [{ depth: 0, path: root }]
  let visitedEntries = 0

  while (queue.length > 0 && visitedEntries < 2500) {
    const current = queue.shift()
    if (!current) break

    let entries: Dirent<string>[]
    try {
      entries = readdirSync(current.path, {
        encoding: 'utf8',
        withFileTypes: true,
      }) as Dirent<string>[]
    } catch {
      continue
    }

    for (const entry of entries) {
      visitedEntries += 1
      const entryPath = join(current.path, entry.name)
      if (entry.isFile()) {
        const name = entry.name.toLowerCase()
        const extension = name.slice(name.lastIndexOf('.'))
        if (extension === '.cmd' || extension === '.bat' || extension === '.exe') {
          const currentPath = index.get(name)
          if (!currentPath || executablePriority(name) < executablePriority(currentPath)) {
            index.set(name, entryPath)
          }
        }
      }
      if (entry.isDirectory() && current.depth < maxDepth) {
        queue.push({ depth: current.depth + 1, path: entryPath })
      }
      if (visitedEntries >= 2500) break
    }
  }
}

const discoveryIndexes = new Map<string, DiscoveryIndex>()

const getDiscoveryKey = (env: NodeJS.ProcessEnv) =>
  ['APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData']
    .map((key) => `${key}=${getEnvValue(env, key) ?? ''}`)
    .join('\n')

const getDiscoveryIndex = (env: NodeJS.ProcessEnv): DiscoveryIndex => {
  const key = getDiscoveryKey(env)
  const cached = discoveryIndexes.get(key)
  if (cached) return cached

  const index: DiscoveryIndex = new Map()
  for (const root of getWindowsCliSearchRoots(env)) {
    const maxDepth = root.toLowerCase().endsWith('\\programs') ? 4 : 2
    scanRoot(root, maxDepth, index)
  }
  discoveryIndexes.set(key, index)
  return index
}

/**
 * Finds standalone Windows CLI shims that are installed outside PATH.
 * Search is deliberately bounded to common per-user/package-manager roots;
 * recursively walking the whole system drive would be slow and surprising.
 */
export const discoverWindowsCommandPath = (
  commandNames: string[],
  env: NodeJS.ProcessEnv
): string | undefined => {
  const names = commandNames
    .flatMap((name) => {
      const extension = name.slice(name.lastIndexOf('.')).toLowerCase()
      if (extension === '.cmd' || extension === '.bat' || extension === '.exe') {
        return [name]
      }
      return [`${name}.cmd`, `${name}.bat`, `${name}.exe`]
    })
    .filter((name, index, all) => all.indexOf(name) === index)
  const index = getDiscoveryIndex(env)
  return names.map((name) => index.get(name.toLowerCase())).find(Boolean)
}
