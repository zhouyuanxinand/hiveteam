import { type ExecFileOptions, execFile } from 'node:child_process'

import { type FsProbeResponse, probeDirectory } from './fs-browse.js'

// macOS Cocoa returns -1743 when the user clicks Cancel in `choose folder`.
// osascript maps that to exit code 1 with the message on stderr.
const MACOS_CANCEL_PATTERNS = [/-128/, /-1743/, /user canceled/i, /execution error/i]
// zenity documents exit code 1 on Cancel. kdialog uses exit code 1 as well.
const LINUX_CANCEL_EXIT_CODES = new Set([1])
const WINDOWS_PICKER_PATH_PREFIX = 'HIVE_PICKER_PATH_BASE64:'

type SpawnResult = {
  stderr: string
  stdout: string
  status: number | null
  signal: string | null
  timedOut: boolean
  spawnError: NodeJS.ErrnoException | null
}

export type RunPickCommand = (
  command: string,
  args: string[],
  options: ExecFileOptions
) => Promise<SpawnResult>

export interface PickFolderOptions {
  now?: () => number
  platform?: NodeJS.Platform
  runCommand?: RunPickCommand
}

export interface PickFolderResponse {
  canceled: boolean
  error: string | null
  path: string | null
  probe: FsProbeResponse | null
  supported: boolean
}

interface ExecFileError extends NodeJS.ErrnoException {
  killed?: boolean
  signal?: NodeJS.Signals | null
}

const defaultRunCommand: RunPickCommand = (command, args, options) =>
  new Promise<SpawnResult>((resolve) => {
    const child = execFile(command, args, options, (error, stdout, stderr) => {
      const errno = error as ExecFileError | null
      const timedOut = !!errno?.killed && errno?.signal === 'SIGTERM'
      // execFile surfaces ENOENT when the binary is missing; keep the raw errno
      // so the caller can distinguish "command not installed" from "user cancel".
      resolve({
        stderr: String(stderr ?? ''),
        stdout: String(stdout ?? ''),
        status: typeof errno?.code === 'number' ? errno.code : (child.exitCode ?? 0),
        signal: typeof errno?.signal === 'string' ? errno.signal : null,
        spawnError:
          errno && typeof errno.code === 'string' ? (errno as NodeJS.ErrnoException) : null,
        timedOut,
      })
    })
  })

const emptyResponse = (overrides: Partial<PickFolderResponse> = {}): PickFolderResponse => ({
  canceled: false,
  error: null,
  path: null,
  probe: null,
  supported: true,
  ...overrides,
})

const parseWindowsPickedPath = (stdout: string): string => {
  const encodedLine = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.startsWith(WINDOWS_PICKER_PATH_PREFIX))

  if (!encodedLine) return stdout.trim().replace(/^\uFEFF/u, '')

  const encodedPath = encodedLine.slice(WINDOWS_PICKER_PATH_PREFIX.length)
  return Buffer.from(encodedPath, 'base64').toString('utf8').trim()
}

const finalizeWithProbe = async (path: string): Promise<PickFolderResponse> => {
  // A native OS picker can select a valid workspace on another drive or
  // outside the user's home directory. The server-side browse API remains
  // sandboxed, but the user explicitly chose this path in the OS dialog.
  const probe = await probeDirectory(path, { allowOutsideRoot: true })
  if (!probe.ok || !probe.is_dir) {
    return emptyResponse({
      error: 'Selected path is not a directory or cannot be accessed.',
      path,
      probe,
    })
  }
  return emptyResponse({ path: probe.path, probe })
}

const macOsPick = async (run: RunPickCommand): Promise<PickFolderResponse> => {
  const script = 'POSIX path of (choose folder with prompt "Select Hive workspace")'
  const result = await run('osascript', ['-e', script], {})

  if (result.spawnError?.code === 'ENOENT') {
    return emptyResponse({ error: 'osascript is unavailable on this host.', supported: false })
  }
  if (result.timedOut) {
    return emptyResponse({ error: 'Folder picker timed out before a folder was selected.' })
  }
  const combinedStderr = result.stderr.toLowerCase()
  if (result.status !== 0) {
    if (MACOS_CANCEL_PATTERNS.some((re) => re.test(combinedStderr))) {
      return emptyResponse({ canceled: true })
    }
    // Any non-zero exit code without stdout is treated as cancel rather than a
    // hard failure — the user is just closing the dialog.
    if (result.stdout.trim().length === 0) return emptyResponse({ canceled: true })
  }
  const picked = result.stdout.trim().replace(/\/$/, '')
  if (picked.length === 0) return emptyResponse({ canceled: true })
  return finalizeWithProbe(picked)
}

const linuxPick = async (run: RunPickCommand): Promise<PickFolderResponse> => {
  const result = await run(
    'zenity',
    ['--file-selection', '--directory', '--title=Select Hive workspace'],
    {}
  )
  if (result.spawnError?.code === 'ENOENT') {
    return emptyResponse({
      error: 'zenity not installed. Install zenity or use Advanced: paste path.',
      supported: false,
    })
  }
  if (result.timedOut) {
    return emptyResponse({ error: 'Folder picker timed out before a folder was selected.' })
  }
  if (result.status !== 0 && LINUX_CANCEL_EXIT_CODES.has(result.status ?? 0)) {
    return emptyResponse({ canceled: true })
  }
  const picked = result.stdout.trim()
  if (picked.length === 0) return emptyResponse({ canceled: true })
  return finalizeWithProbe(picked)
}

const windowsPick = async (run: RunPickCommand): Promise<PickFolderResponse> => {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
    '$dialog.Description = "Select Hive workspace folder. Documents inside it are detected after you click OK."',
    '$dialog.ShowNewFolderButton = $false',
    '$result = $dialog.ShowDialog()',
    `if ($result -eq [System.Windows.Forms.DialogResult]::OK) { $encodedPath = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($dialog.SelectedPath)); [Console]::Out.WriteLine("${WINDOWS_PICKER_PATH_PREFIX}" + $encodedPath); exit 0 }`,
    'exit 1',
  ].join('; ')
  const result = await run(
    'powershell.exe',
    ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script],
    {}
  )
  if (result.spawnError?.code === 'ENOENT') {
    return emptyResponse({
      error: 'PowerShell is unavailable on this host. Use Advanced: paste path.',
      supported: false,
    })
  }
  if (result.timedOut) {
    return emptyResponse({ error: 'Folder picker timed out before a folder was selected.' })
  }
  if (result.status !== 0) {
    const stderr = result.stderr.trim()
    if (stderr.length > 0) {
      return emptyResponse({ error: `Folder picker failed: ${stderr}` })
    }
    return emptyResponse({ canceled: true })
  }
  // Windows PowerShell's redirected stdout encoding depends on the host code
  // page. Returning the selected Unicode path as ASCII base64 avoids corrupting
  // paths such as D:\桌面 before Node probes the directory. Keep accepting raw
  // output for compatibility with older helpers and test doubles.
  const picked = parseWindowsPickedPath(result.stdout)
  if (picked.length === 0) return emptyResponse({ canceled: true })
  return finalizeWithProbe(picked)
}

export const pickFolder = async (options: PickFolderOptions = {}): Promise<PickFolderResponse> => {
  const platform = options.platform ?? process.platform
  const run = options.runCommand ?? defaultRunCommand

  if (platform === 'darwin') return macOsPick(run)
  if (platform === 'linux') return linuxPick(run)
  if (platform === 'win32') return windowsPick(run)
  return emptyResponse({
    error: 'Native folder picker not supported on this platform. Use Advanced: paste path.',
    supported: false,
  })
}
