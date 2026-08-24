import { accessSync, constants, existsSync } from 'node:fs'
import { basename, delimiter, dirname, extname, isAbsolute, join } from 'node:path'

import { discoverWindowsCommandPath } from './command-discovery.js'
import { buildCmdCallCommand } from './windows-command-line.js'

const hasPathSeparator = (command: string) => command.includes('/') || command.includes('\\')

const WINDOWS_EXECUTABLE_EXTENSIONS = new Set([
  '.com',
  '.exe',
  '.bat',
  '.cmd',
  '.cjs',
  '.js',
  '.mjs',
])

const isWindowsAppPackagePath = (path: string) =>
  path.replaceAll('/', '\\').toLowerCase().includes('\\windowsapps\\')

const isPackagedDesktopAppExecutable = (path: string) => {
  if (extname(path).toLowerCase() !== '.exe') return false
  const resourcesDir = join(dirname(path), 'resources')
  return (
    existsSync(join(resourcesDir, 'app.asar')) ||
    existsSync(join(resourcesDir, 'app.asar.unpacked'))
  )
}

const canExecute = (path: string, platform = process.platform): boolean => {
  if (platform === 'win32') {
    // WindowsApps contains protected desktop-app resources. They can appear
    // on PATH but cannot be spawned as a child PTY by Hive. A standalone CLI
    // shim (for example a .cmd) is required instead.
    if (isWindowsAppPackagePath(path)) return false
    // CreateProcess does not treat arbitrary extensionless files as CLI
    // executables. Only PATHEXT-style files are valid launch targets here.
    if (!WINDOWS_EXECUTABLE_EXTENSIONS.has(extname(path).toLowerCase())) return false
  }
  try {
    accessSync(path, platform === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

const createCommandNotFoundError = (command: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${command} CLI not found in PATH`), {
    code: 'ENOENT',
    path: command,
  })

const createCommandAccessDeniedError = (command: string, path: string): NodeJS.ErrnoException =>
  Object.assign(
    new Error(
      `${command} CLI points to a protected WindowsApps app resource (${path}). Install a standalone CLI available on PATH.`
    ),
    { code: 'EACCES', path }
  )

const createDesktopAppError = (command: string, path: string): NodeJS.ErrnoException =>
  Object.assign(
    new Error(
      `${command} CLI points to a desktop app executable (${path}), not a standalone CLI. Install the CLI separately or bind its CLI launcher.`
    ),
    { code: 'ENOEXEC', path }
  )

interface ResolvedSpawnCommand {
  args: string[] | string
  command: string
}

const getEnvValue = (
  env: NodeJS.ProcessEnv,
  key: string,
  platform = process.platform
): string | undefined => {
  if (platform !== 'win32') return env[key]
  if (Object.hasOwn(env, key)) return env[key]
  const matchedKey = Object.keys(env)
    .filter((item) => item.toLowerCase() === key.toLowerCase())
    .at(-1)
  return matchedKey ? env[matchedKey] : undefined
}

const getWindowsExecutableNames = (
  command: string,
  env: NodeJS.ProcessEnv,
  platform = process.platform
): string[] => {
  if (extname(command)) return [command]

  const extensions = (getEnvValue(env, 'PATHEXT', platform) ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean)
  return extensions.map((extension) => `${command}${extension}`)
}

const getExecutableNames = (
  command: string,
  env: NodeJS.ProcessEnv,
  platform = process.platform
): string[] =>
  platform === 'win32' ? getWindowsExecutableNames(command, env, platform) : [command]

export const resolveCommandPath = (
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  platform = process.platform
): string => {
  let protectedWindowsAppPath: string | undefined
  let packagedDesktopAppPath: string | undefined
  const findExecutable = (candidate: string): string | undefined => {
    if (platform === 'win32' && isWindowsAppPackagePath(candidate)) {
      protectedWindowsAppPath ??= candidate
      return undefined
    }
    if (platform === 'win32' && isPackagedDesktopAppExecutable(candidate)) {
      packagedDesktopAppPath ??= candidate
      return undefined
    }
    return canExecute(candidate, platform) ? candidate : undefined
  }

  if (hasPathSeparator(command)) {
    for (const name of getExecutableNames(command, env, platform)) {
      const candidate = isAbsolute(name) ? name : join(cwd, name)
      const executable = findExecutable(candidate)
      if (executable) return executable
    }
    if (protectedWindowsAppPath) {
      throw createCommandAccessDeniedError(command, protectedWindowsAppPath)
    }
    if (packagedDesktopAppPath) {
      throw createDesktopAppError(command, packagedDesktopAppPath)
    }
    throw createCommandNotFoundError(command)
  }

  for (const pathEntry of (getEnvValue(env, 'PATH', platform) ?? '').split(delimiter)) {
    if (!pathEntry) continue
    for (const name of getExecutableNames(command, env, platform)) {
      const candidate = join(pathEntry, name)
      const executable = findExecutable(candidate)
      if (executable) return executable
    }
  }

  if (platform === 'win32') {
    const discovered = discoverWindowsCommandPath([command], env)
    const executable = discovered ? findExecutable(discovered) : undefined
    if (executable) return executable
  }

  if (protectedWindowsAppPath) {
    throw createCommandAccessDeniedError(command, protectedWindowsAppPath)
  }
  if (packagedDesktopAppPath) {
    throw createDesktopAppError(command, packagedDesktopAppPath)
  }
  throw createCommandNotFoundError(command)
}

const isWindowsBatchFile = (command: string) => {
  const extension = extname(command).toLowerCase()
  return extension === '.cmd' || extension === '.bat'
}

const isWindowsNodeScript = (command: string) =>
  new Set(['.cjs', '.js', '.mjs']).has(extname(command).toLowerCase())

const createWindowsBatchCommandLine = (command: string, args: string[]) =>
  `/d /s /c chcp 65001 >nul && ${buildCmdCallCommand(command, args)}`

const isCmdExeShellLaunch = (resolvedCommand: string, args: string[]) =>
  basename(resolvedCommand).toLowerCase() === 'cmd.exe' &&
  args.length === 4 &&
  args[0] === '/d' &&
  args[1] === '/s' &&
  (args[2] === '/c' || args[2] === '/k')

export const resolveSpawnCommand = (
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  args: string[] = [],
  platform = process.platform
): ResolvedSpawnCommand => {
  const resolvedCommand = resolveCommandPath(command, cwd, env, platform)
  if (platform === 'win32' && isWindowsNodeScript(resolvedCommand)) {
    return {
      args: [resolvedCommand, ...args],
      command: process.execPath,
    }
  }
  if (platform === 'win32' && isWindowsBatchFile(resolvedCommand)) {
    return {
      // node-pty accepts a pre-escaped command-line string on Windows. Passing
      // this as an argv array causes its own quoting layer to escape the quotes
      // needed by cmd.exe, so cmd.exe tries to execute the quoted path literally.
      args: createWindowsBatchCommandLine(resolvedCommand, args),
      command: getEnvValue(env, 'ComSpec', platform) ?? 'cmd.exe',
    }
  }
  if (platform === 'win32' && isCmdExeShellLaunch(resolvedCommand, args)) {
    return {
      args: args.join(' '),
      command: resolvedCommand,
    }
  }
  return { args, command: resolvedCommand }
}

export const assertCommandIsExecutable = (
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv
): void => {
  resolveCommandPath(command, cwd, env)
}

export type { ResolvedSpawnCommand }
