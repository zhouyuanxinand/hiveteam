import type { PlatformSupervisor } from './platform-supervisor.mjs'
export interface PlatformLaunchOptions {
  projectRoot: string
  nodeExecutable?: string
  dataDir: string
  runtimePort: number
  runtimeEntry?: string
  webPort?: number
  launchMode?: 'runtime' | 'development'
  environment?: NodeJS.ProcessEnv
  signal?: AbortSignal
}
export interface PlatformLaunch {
  supervisor: PlatformSupervisor
  readonly appOrigin: string
  readonly runtimeOrigin: string
  createLaunchUrl(): Promise<string>
  requestUiBootstrap(): Promise<string>
  stop(): Promise<void>
}
export function launchPlatform(options: PlatformLaunchOptions): Promise<PlatformLaunch>
