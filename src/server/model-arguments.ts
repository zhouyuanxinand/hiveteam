import { basename } from 'node:path'

const MODEL_COMMANDS = new Set([
  'agy',
  'claude',
  'codex',
  'cursor',
  'cursor-agent',
  'gemini',
  'hermes',
  'kimi',
  'opencode',
  'qwen',
])

const getCommandName = (command: string) => {
  const name = basename(command.trim()).toLowerCase()
  return name.replace(/\.(?:cmd|bat|com|exe)$/i, '')
}

export const supportsModelSelection = (command: string) =>
  MODEL_COMMANDS.has(getCommandName(command))

export const withModelArgument = (args: string[], command: string, model?: string | null) => {
  const trimmedModel = model?.trim() ?? ''
  if (!trimmedModel || !supportsModelSelection(command)) return args

  const nextArgs: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === undefined) continue
    if (arg === '--model') {
      index += 1
      continue
    }
    if (arg.startsWith('--model=')) continue
    nextArgs.push(arg)
  }
  return [...nextArgs, '--model', trimmedModel]
}
