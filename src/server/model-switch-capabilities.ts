import { basename } from 'node:path'

export type ModelSwitchStrategy = 'native-picker' | 'unsupported'

export interface ModelSwitchCapability {
  input: string
  pickerCommand: string
  strategy: ModelSwitchStrategy
}

const normalizeCommand = (command: string) => {
  const name = basename(command.trim()).toLowerCase()
  return name.replace(/\.(?:cmd|bat|com|exe)$/i, '')
}

const NATIVE_PICKERS: Record<string, string> = {
  agy: '/model',
  claude: '/model',
  codex: '/model',
  cursor: '/model',
  'cursor-agent': '/model',
  gemini: '/model',
  hermes: '/model',
  kimi: '/model',
  opencode: '/models',
  qwen: '/model',
}

/**
 * Open each CLI's documented native picker instead of guessing model IDs or
 * provider-specific request payloads in Hive.
 */
export const getModelSwitchCapability = (command: string): ModelSwitchCapability | undefined => {
  const pickerCommand = NATIVE_PICKERS[normalizeCommand(command)]
  if (!pickerCommand) return undefined
  return {
    input: `${pickerCommand}\r`,
    pickerCommand,
    strategy: 'native-picker',
  }
}
