import type { AgentLaunchConfigInput } from './agent-run-store.js'
import { withModelArgument } from './model-arguments.js'
import type { SettingsStore } from './settings-store.js'
import {
  createStartupCommandLaunch,
  getStartupCommandExecutable,
  normalizeExecutableToken,
} from './startup-command-parser.js'

export const resolveCommandPresetLaunchConfig = (
  settings: SettingsStore,
  commandPresetId: string,
  model?: string | null
): AgentLaunchConfigInput | undefined => {
  const preset = settings.getCommandPreset(commandPresetId)
  if (!preset) return undefined
  return {
    args: withModelArgument(preset.args, preset.command, model),
    command: preset.command,
    commandPresetId: preset.id,
  }
}

const findPresetForStartupCommand = (
  settings: SettingsStore,
  startupCommand: string,
  commandPresetId: string | null
) => {
  if (commandPresetId) return settings.getCommandPreset(commandPresetId)
  const brandId = normalizeExecutableToken(getStartupCommandExecutable(startupCommand))
  return brandId ? settings.getCommandPreset(brandId) : undefined
}

export const resolveStartupCommandLaunchConfig = (
  settings: SettingsStore,
  startupCommand: string,
  commandPresetId: string | null = null
): AgentLaunchConfigInput | undefined => {
  const trimmedStartupCommand = startupCommand.trim()
  if (!trimmedStartupCommand) return undefined
  const parsed = createStartupCommandLaunch(trimmedStartupCommand)
  const preset = findPresetForStartupCommand(settings, trimmedStartupCommand, commandPresetId)
  return {
    command: parsed.command,
    args: parsed.args,
    commandPresetId: null,
    interactiveCommand: preset?.command ?? getStartupCommandExecutable(trimmedStartupCommand),
    presetAugmentationDisabled: true,
    sessionIdCapture: preset?.sessionIdCapture ?? null,
  }
}
