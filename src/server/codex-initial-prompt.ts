import { extname } from 'node:path'
import { resolveCommandPath } from './agent-command-resolver.js'
import type { AgentLaunchConfigInput } from './agent-run-store.js'
import { resolveCodexNativeExecutable } from './codex-native-executable.js'

export const usesCodexInitialPrompt = (
  config: AgentLaunchConfigInput,
  presetId: string | null,
  platform: NodeJS.Platform = process.platform
) =>
  platform === 'win32' &&
  presetId === 'codex' &&
  !config.presetAugmentationDisabled &&
  !config.resumedSessionId

// Size the quoted CreateProcess arguments, including doubled backslashes
// before quotes/end-of-argument. Never silently truncate a startup contract.
const quotedLength = (value: string) =>
  value.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, '$1$1').length + 2

/** Windows Codex reads console key records, which can lose line breaks and
 * split one bracketed paste into unrelated bursts. Its native initial prompt
 * preserves the full message without interpreting it as terminal keystrokes. */
export const prepareCodexInitialPrompt = async (
  config: AgentLaunchConfigInput,
  cwd: string,
  env: NodeJS.ProcessEnv,
  text: string
) => {
  const launcher = resolveCommandPath(config.command, cwd, env)
  const command = await resolveCodexNativeExecutable(launcher)
  if (!['.exe', '.js', '.cjs', '.mjs'].includes(extname(command).toLowerCase()))
    throw new Error(
      'Codex startup requires its native executable or Node launcher on Windows; the configured shell wrapper cannot safely receive a multiline initial prompt.'
    )
  const configuredArgs = config.args ?? []
  const args = [...configuredArgs, ...(configuredArgs.includes('--') ? [] : ['--']), text]
  const invocation =
    extname(command).toLowerCase() === '.exe'
      ? [command, ...args]
      : [process.execPath, command, ...args]
  const length = invocation.reduce((total, value) => total + quotedLength(value) + 1, 0)
  if (length >= 32_767)
    throw new Error(
      'Codex startup instructions exceed the Windows command-line limit. Reduce the workspace document catalog or startup context before retrying; no partial instructions were sent.'
    )
  return { command, args }
}
