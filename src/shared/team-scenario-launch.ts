import type { TeamScenarioDefinition } from './team-scenarios.js'
import type { TeamListItemPayload, WorkerRole } from './types.js'

export interface ScenarioStartResult {
  queue_id?: string
  id: string
  error: string | null
  ok: boolean
  run_id: string | null
}
export interface ScenarioLaunchMember {
  id: string
  name: string
  role: WorkerRole
  state: 'created' | 'queued' | 'starting' | 'started' | 'failed' | 'reused'
  error: string | null
  duration_ms: number | null
}
export interface ScenarioLaunchPayload {
  command_preset_id: string
  created: string[]
  reused: string[]
  scenario: TeamScenarioDefinition
  started: ScenarioStartResult[]
  workers: TeamListItemPayload[]
}
export type ScenarioLaunchEvent =
  | { type: 'progress'; members: ScenarioLaunchMember[] }
  | { type: 'result'; result: ScenarioLaunchPayload }
  | { type: 'error'; error: string }
