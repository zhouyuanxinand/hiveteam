import { basename } from 'node:path'

import type { AgentLaunchConfigInput } from './agent-run-store.js'

export type TerminalInputProfile = 'default' | 'opencode'

export interface TerminalRunSummary {
  agent_id: string
  agent_name: string
  run_id: string
  status: string
  /** Native CLI session/thread reused when this agent is restarted. */
  thread_id?: string | null
  terminal_input_profile: TerminalInputProfile
}

const normalizeExecutable = (value: string | null | undefined): string | null => {
  if (!value) return null
  const normalized = basename(value).toLowerCase()
  return normalized.replace(/\.(cmd|exe)$/u, '')
}

export const resolveTerminalInputProfile = (
  config: AgentLaunchConfigInput | undefined
): TerminalInputProfile => {
  if (!config) return 'default'
  if (config.commandPresetId === 'opencode') return 'opencode'

  const executable =
    normalizeExecutable(config.interactiveCommand) ?? normalizeExecutable(config.command)
  return executable === 'opencode' ? 'opencode' : 'default'
}
