import { type ExecFileOptions, execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

import {
  getDefaultOpenTargetIdForPlatform,
  getEffectiveOpenTargetId,
  isOpenTargetId,
  type OpenTargetId,
  type OpenTargetPlatform,
  type OpenWorkspaceErrorCode,
} from '../shared/open-targets.js'

export type {
  OpenTargetId,
  OpenTargetPlatform,
  OpenWorkspaceErrorCode,
} from '../shared/open-targets.js'
export {
  getEffectiveOpenTargetId,
  isOpenTargetId,
  isOpenTargetSupported,
  OPEN_TARGET_IDS_BY_PLATFORM,
} from '../shared/open-targets.js'

export const resolveOpenTargetPlatform = (platform: NodeJS.Platform): OpenTargetPlatform => {
  if (platform === 'darwin') return 'mac'
  if (platform === 'win32') return 'windows'
  if (platform === 'linux') return 'linux'
  return 'other'
}

export interface OpenAttempt {
  command: string
  args: string[]
}

const macAttempts = (targetId: OpenTargetId, path: string): OpenAttempt[] => {
  switch (targetId) {
    case 'finder':
      return [{ command: 'open', args: [path] }]
    case 'vscode':
      return [{ command: 'open', args: ['-a', 'Visual Studio Code', path] }]
    case 'vscode-insiders':
      return [{ command: 'open', args: ['-a', 'Visual Studio Code - Insiders', path] }]
    case 'cursor':
      return [{ command: 'open', args: ['-a', 'Cursor', path] }]
    case 'terminal':
      return [{ command: 'open', args: ['-a', 'Terminal', path] }]
    case 'ghostty':
      return [{ command: 'open', args: ['-a', 'Ghostty', path] }]
    case 'zed':
      return [{ command: 'open', args: ['-a', 'Zed', path] }]
  }
}

const linuxAttempts = (targetId: OpenTargetId, path: string): OpenAttempt[] => {
  switch (targetId) {
    case 'finder':
      return [{ command: 'xdg-open', args: [path] }]
    case 'vscode':
      return [{ command: 'code', args: [path] }]
    case 'vscode-insiders':
      return [{ command: 'code-insiders', args: [path] }]
    case 'cursor':
      return [{ command: 'cursor', args: [path] }]
    case 'zed':
      return [{ command: 'zed', args: [path] }]
    default:
      return [{ command: 'xdg-open', args: [path] }]
  }
}

const windowsAttempts = (targetId: OpenTargetId, path: string): OpenAttempt[] => {
  switch (targetId) {
    case 'finder':
      return [{ command: 'explorer', args: [path] }]
    case 'vscode':
      return [{ command: 'code.cmd', args: [path] }]
    case 'vscode-insiders':
      return [{ command: 'code-insiders.cmd', args: [path] }]
    case 'cursor':
      return [{ command: 'cursor.cmd', args: [path] }]
    case 'zed':
      return [{ command: 'zed.cmd', args: [path] }]
    default:
      return [{ command: 'explorer', args: [path] }]
  }
}

/**
 * Returns the ordered list of commands to try. First success wins; remaining
 * entries are fallbacks (e.g. IntelliJ IDEA → IntelliJ IDEA CE on older Macs).
 * Empty list means the requested target is unsupported on this platform —
 * callers should have already routed through `getEffectiveOpenTargetId` to
 * fall back, so this should never happen in practice.
 */
export const buildOpenAttempts = (
  targetId: OpenTargetId,
  path: string,
  platform: OpenTargetPlatform
): OpenAttempt[] => {
  const effectiveTargetId = getEffectiveOpenTargetId(targetId, platform)
  if (platform === 'mac') return macAttempts(effectiveTargetId, path)
  if (platform === 'linux') return linuxAttempts(effectiveTargetId, path)
  if (platform === 'windows') return windowsAttempts(effectiveTargetId, path)
  return [{ command: 'open', args: [path] }]
}

export interface OpenCommandSuccess {
  ok: true
  effectiveTargetId: OpenTargetId
}

export interface OpenCommandFailure {
  ok: false
  effectiveTargetId: OpenTargetId
  errorCode: OpenWorkspaceErrorCode
  stderr: string
}

export type OpenCommandResult = OpenCommandSuccess | OpenCommandFailure

interface SpawnResult {
  stderr: string
  stdout: string
  status: number | null
  signal: string | null
  spawnError: NodeJS.ErrnoException | null
}

type WindowsCommandMetadata = {
  appExecutables: readonly string[]
  productDirectories: readonly string[]
}

/**
 * Windows GUI installers normally put these shims on PATH, but Hive may be
 * started by a shortcut, a service, or an older shell whose PATH predates the
 * editor installation. Keep the app names here rather than accepting a path
 * from the web client, then resolve the launcher from PATH, standard install
 * locations, or the Windows App Paths registry.
 */
const WINDOWS_COMMAND_METADATA: Record<string, WindowsCommandMetadata> = {
  'code.cmd': {
    appExecutables: ['Code.exe'],
    productDirectories: ['Microsoft VS Code'],
  },
  'code-insiders.cmd': {
    appExecutables: ['Code - Insiders.exe'],
    productDirectories: ['Microsoft VS Code Insiders'],
  },
  'cursor.cmd': {
    appExecutables: ['Cursor.exe'],
    productDirectories: ['Cursor'],
  },
  'zed.cmd': {
    appExecutables: ['Zed.exe'],
    productDirectories: ['Zed'],
  },
}

const WINDOWS_LOOKUP_OPTIONS: ExecFileOptions = {
  windowsHide: true,
  timeout: 1500,
  maxBuffer: 64 * 1024,
}

const isWindowsCommandShim = (command: string): boolean =>
  process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command)

const isExistingFile = (path: string): boolean => {
  try {
    return existsSync(path)
  } catch {
    return false
  }
}

const getWindowsPathCandidates = (command: string): string[] => {
  const pathEntries = (process.env.PATH ?? '')
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => join(entry, command))

  const metadata = WINDOWS_COMMAND_METADATA[command]
  if (!metadata) return pathEntries

  const standardCandidates = metadata.productDirectories.flatMap((productDirectory) => {
    const roots = [
      process.env.LOCALAPPDATA
        ? join(process.env.LOCALAPPDATA, 'Programs', productDirectory)
        : null,
      process.env.ProgramW6432 ? join(process.env.ProgramW6432, productDirectory) : null,
      process.env.ProgramFiles ? join(process.env.ProgramFiles, productDirectory) : null,
      process.env['ProgramFiles(x86)']
        ? join(process.env['ProgramFiles(x86)'], productDirectory)
        : null,
    ].filter((root): root is string => root !== null)
    return roots.map((root) => join(root, 'bin', command))
  })

  return [...pathEntries, ...standardCandidates]
}

const findExistingWindowsCommand = (candidates: readonly string[]): string | null => {
  for (const candidate of candidates) {
    if (isExistingFile(candidate)) return candidate
  }
  return null
}

const findWindowsCommandWithWhere = async (command: string): Promise<string | null> =>
  new Promise((resolve) => {
    execFile('where.exe', [command], WINDOWS_LOOKUP_OPTIONS, (_error, stdout) => {
      const candidates = String(stdout ?? '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
      resolve(findExistingWindowsCommand(candidates))
    })
  })

const findWindowsAppExecutableFromRegistry = async (
  appExecutable: string
): Promise<string | null> => {
  const registryRoots = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths',
  ]

  for (const registryRoot of registryRoots) {
    const key = `${registryRoot}\\${appExecutable}`
    const value = await new Promise<string | null>((resolve) => {
      execFile('reg.exe', ['query', key, '/ve'], WINDOWS_LOOKUP_OPTIONS, (_error, stdout) => {
        const match = String(stdout ?? '').match(
          /^\s*\([^)]*\)\s+REG_(?:SZ|EXPAND_SZ)\s+(.+?)\s*$/im
        )
        resolve(match?.[1]?.trim().replace(/^"|"$/g, '') ?? null)
      })
    })
    if (value && isExistingFile(value)) return value
  }
  return null
}

/**
 * Resolve a Windows command shim without trusting that the Hive process was
 * launched with the user's interactive PATH. The returned value is still a
 * fixed launcher discovered from the machine; no workspace input participates
 * in the lookup.
 */
export const resolveWindowsCommandShim = async (command: string): Promise<string> => {
  if (!isWindowsCommandShim(command)) return command

  const fromKnownLocations = findExistingWindowsCommand(getWindowsPathCandidates(command))
  if (fromKnownLocations) return fromKnownLocations

  const fromWhere = await findWindowsCommandWithWhere(command)
  if (fromWhere) return fromWhere

  const metadata = WINDOWS_COMMAND_METADATA[command]
  if (metadata) {
    for (const appExecutable of metadata.appExecutables) {
      const appPath = await findWindowsAppExecutableFromRegistry(appExecutable)
      if (!appPath) continue
      const shimPath = join(dirname(appPath), 'bin', command)
      if (isExistingFile(shimPath)) return shimPath
    }
  }

  // Let cmd.exe produce the normal, actionable error if the application is
  // genuinely unavailable. classifyFailure converts it into the localized
  // "add the CLI to PATH" message instead of hiding the original stderr.
  return command
}

export type RunOpenCommand = (
  command: string,
  args: string[],
  options: ExecFileOptions
) => Promise<SpawnResult>

interface ExecFileError extends NodeJS.ErrnoException {
  signal?: NodeJS.Signals | null
}

const defaultRunOpenCommand: RunOpenCommand = (command, args, options) =>
  (async () => {
    // Node cannot spawn a Windows .cmd shim directly with execFile. Resolve
    // the shim first, then route it through cmd.exe as separate argv entries
    // instead of shell:true, which would concatenate an arbitrary workspace
    // path into a shell command.
    const windowsCommandShim = isWindowsCommandShim(command)
    const resolvedCommand = windowsCommandShim ? await resolveWindowsCommandShim(command) : command
    const executable = windowsCommandShim
      ? (process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe')
      : resolvedCommand
    const childArgs = windowsCommandShim ? ['/d', '/c', resolvedCommand, ...args] : args

    return new Promise<SpawnResult>((resolve) => {
      const child = execFile(executable, childArgs, options, (error, stdout, stderr) => {
        const errno = error as ExecFileError | null
        resolve({
          stderr: String(stderr ?? ''),
          stdout: String(stdout ?? ''),
          status: typeof errno?.code === 'number' ? errno.code : (child.exitCode ?? 0),
          signal: typeof errno?.signal === 'string' ? errno.signal : null,
          spawnError:
            errno && typeof errno.code === 'string' ? (errno as NodeJS.ErrnoException) : null,
        })
      })
    })
  })()

const APP_NOT_INSTALLED_PATTERNS = [
  /unable to find application/i,
  /can'?t find/i,
  /not authorized to send keystrokes/i,
  /application can'?t be found/i,
]

const COMMAND_NOT_IN_PATH_PATTERNS = [
  /is not recognized as an internal or external command/i,
  /the system cannot find the path specified/i,
]

const classifyFailure = (result: SpawnResult): OpenWorkspaceErrorCode => {
  if (result.spawnError?.code === 'ENOENT') return 'command-not-in-path'
  const stderr = result.stderr.toLowerCase()
  if (COMMAND_NOT_IN_PATH_PATTERNS.some((re) => re.test(stderr))) {
    return 'command-not-in-path'
  }
  if (APP_NOT_INSTALLED_PATTERNS.some((re) => re.test(stderr))) return 'app-not-installed'
  return 'unknown'
}

export interface OpenWorkspaceInput {
  path: string
  targetId: OpenTargetId
}

export interface OpenWorkspaceOptions {
  platform?: NodeJS.Platform
  runCommand?: RunOpenCommand
}

/**
 * Workspace paths originate from the OS folder picker or from manual paste;
 * the picker output is sandbox-validated at create time, but a path stored
 * before path-validation existed (or one pasted into a hypothetical migration
 * future) could contain `\n` / `\0`. Reject those here so we never hand an
 * ambiguous path to `xdg-open`, where shell wrappers split on newline.
 */
export const isOpenWorkspacePathSafe = (path: string): boolean => {
  if (path.length === 0) return false
  for (let i = 0; i < path.length; i++) {
    const code = path.charCodeAt(i)
    if (code === 0 || code === 10 || code === 13) return false
  }
  return true
}

export const openWorkspace = async (
  input: OpenWorkspaceInput,
  options: OpenWorkspaceOptions = {}
): Promise<OpenCommandResult> => {
  const platform = resolveOpenTargetPlatform(options.platform ?? process.platform)
  const run = options.runCommand ?? defaultRunOpenCommand

  if (!isOpenTargetId(input.targetId)) {
    return {
      ok: false,
      effectiveTargetId: getDefaultOpenTargetIdForPlatform(platform),
      errorCode: 'invalid-target',
      stderr: `Unknown open target: ${String(input.targetId)}`,
    }
  }

  if (!isOpenWorkspacePathSafe(input.path)) {
    return {
      ok: false,
      effectiveTargetId: input.targetId,
      errorCode: 'invalid-path',
      stderr: 'Workspace path contains newline or null byte and was rejected.',
    }
  }

  const effectiveTargetId = getEffectiveOpenTargetId(input.targetId, platform)
  const attempts = buildOpenAttempts(input.targetId, input.path, platform)

  let lastFailure: SpawnResult | null = null
  for (const attempt of attempts) {
    const result = await run(attempt.command, attempt.args, {})

    // Windows `explorer.exe` returns exit code 1 even on success — checking
    // exit code here would surface a spurious error to the user on every
    // File Explorer open. spawnError still catches the "explorer not on PATH"
    // case, which is the only real failure mode worth surfacing.
    if (attempt.command === 'explorer') {
      if (result.spawnError?.code === 'ENOENT') {
        lastFailure = result
        continue
      }
      return { ok: true, effectiveTargetId }
    }

    if (!result.spawnError && (result.status === 0 || result.status === null)) {
      return { ok: true, effectiveTargetId }
    }
    lastFailure = result
  }

  const fallback: SpawnResult = lastFailure ?? {
    stderr: 'No command attempts were made.',
    stdout: '',
    status: null,
    signal: null,
    spawnError: null,
  }
  return {
    ok: false,
    effectiveTargetId,
    errorCode: classifyFailure(fallback),
    stderr: fallback.stderr.trim() || fallback.stdout.trim() || 'Failed to open workspace.',
  }
}
