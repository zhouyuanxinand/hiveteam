import { execFile } from 'node:child_process'

export interface AutostartCommand {
  executable: string
  args: string[]
  input?: string
}
export interface AutostartCommandResult {
  stdout: string
  stderr: string
  exitCode: number
}
export type RunAutostartCommand = (command: AutostartCommand) => Promise<AutostartCommandResult>

export const runAutostartCommand: RunAutostartCommand = ({ executable, args, input }) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      executable,
      args,
      { encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== 'number') {
          reject(error)
          return
        }
        resolve({ stdout, stderr, exitCode: typeof error?.code === 'number' ? error.code : 0 })
      }
    )
    child.stdin?.on('error', reject)
    child.stdin?.end(input ?? '')
  })

export const requireCommandSuccess = (result: AutostartCommandResult, operation: string) => {
  if (result.exitCode !== 0)
    throw new Error(`${operation} failed (${result.exitCode}): ${result.stderr.trim()}`)
  return result.stdout
}
