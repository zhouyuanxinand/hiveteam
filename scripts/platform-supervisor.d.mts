import type { ChildProcess } from 'node:child_process'

export class PlatformRestartLimitError extends Error {
  readonly code: 'platform_restart_limit'
  constructor(maxRestarts: number, cause: unknown)
}

export interface PlatformStatus {
  state: 'starting' | 'running' | 'restarting' | 'stopping' | 'stopped' | 'failed'
  restart_count: number
  last_error: string | null
  children: Array<{ name: string; pid: number | null }>
}
export interface PlatformService {
  name: string
  command: string
  args: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  readyUrl?: string
}
export interface PlatformSupervisorOptions {
  services: PlatformService[]
  retryDelaysMs?: number[]
  maxRestarts?: number
  stableAfterMs?: number
  startupTimeoutMs?: number
  healthIntervalMs?: number
  healthTimeoutMs?: number
  unhealthyThreshold?: number
  shutdownTimeoutMs?: number
}
export interface PlatformSupervisor {
  start(): Promise<void>
  stop(): Promise<void>
  getChild(name: string): ChildProcess | undefined
  getPort(name: string): number | null
  getStatus(): PlatformStatus
  onReady(callback: (status: PlatformStatus) => void): () => void
  onFailed(callback: (status: PlatformStatus) => void): () => void
}
export function createPlatformSupervisor(options: PlatformSupervisorOptions): PlatformSupervisor
