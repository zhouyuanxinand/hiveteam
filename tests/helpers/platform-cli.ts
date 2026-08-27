import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// biome-ignore lint/suspicious/noControlCharactersInRegex: PTY output intentionally contains ANSI OSC control sequences.
const ANSI_OSC_SEQUENCE = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g
// biome-ignore lint/suspicious/noControlCharactersInRegex: PTY output intentionally contains ANSI CSI control sequences.
const ANSI_CSI_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/g

/**
 * Write a small Node CLI fixture that can be launched both by Unix PATH lookup
 * and by Windows CreateProcess. Windows does not execute extensionless files,
 * so the Windows variant keeps the implementation in a .mjs file and exposes a
 * real .cmd shim with the same command name. The .mjs path is returned so
 * callers that bind an absolute command bypass cmd.exe quoting entirely;
 * PATH-based callers still resolve the generated .cmd shim by command name.
 */
export const writeNodeCli = (directory: string, name: string, source: string): string => {
  if (process.platform === 'win32') {
    const scriptPath = join(directory, `${name}.mjs`)
    const commandPath = join(directory, `${name}.cmd`)
    writeFileSync(scriptPath, source)
    writeFileSync(
      commandPath,
      `@echo off\r\n"${process.execPath}" "%~dp0${name}.mjs" %*\r\n`,
      'utf8'
    )
    return scriptPath
  }

  const commandPath = join(directory, name)
  writeFileSync(commandPath, source, 'utf8')
  chmodSync(commandPath, 0o755)
  return commandPath
}

export const normalizePtyText = (value: string) =>
  value
    .replace(ANSI_OSC_SEQUENCE, '')
    .replace(ANSI_CSI_SEQUENCE, '')
    .replace(/[\r\n]/g, '')
