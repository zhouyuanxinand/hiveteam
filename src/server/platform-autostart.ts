import { createHash } from 'node:crypto'
import { access, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { type RunAutostartCommand, runAutostartCommand } from './platform-autostart-command.js'
import {
  type AutostartLaunchConfig,
  readOwnedAutostartConfig,
  writeAutostartFile,
} from './platform-autostart-files.js'
import { createMacAutostart } from './platform-autostart-macos.js'
import { createWindowsAutostart } from './platform-autostart-windows.js'

export type {
  AutostartCommand,
  AutostartCommandResult,
  RunAutostartCommand,
} from './platform-autostart-command.js'

export interface PlatformAutostartStatus {
  supported: boolean
  enabled: boolean
  platform: NodeJS.Platform
  activation: 'next_login'
  error?: string
}

export interface PlatformAutostartOptions {
  dataDir: string
  projectRoot: string
  nodeExecutable: string
  runtimePort: number
  webPort?: number
  launchMode?: 'runtime' | 'development'
  runtimeEntry?: 'source' | 'built'
  platform?: NodeJS.Platform
  homeDir?: string
  uid?: number
  runCommand?: RunAutostartCommand
}

export const createPlatformAutostart = (options: PlatformAutostartOptions) => {
  const platform = options.platform ?? process.platform
  const supported = platform === 'win32' || platform === 'darwin'
  const absolute = (value: string) => {
    if (!isAbsolute(value) || [...value].some((character) => character.charCodeAt(0) < 32))
      throw new Error('Autostart paths must be absolute and contain no control characters.')
    return resolve(value)
  }
  const port = (value: number) => {
    if (!Number.isInteger(value) || value < 1 || value > 65535)
      throw new Error('Autostart ports must be integers between 1 and 65535.')
    return value
  }
  const config: AutostartLaunchConfig = {
    project_root: absolute(options.projectRoot),
    node_executable: absolute(options.nodeExecutable),
    data_dir: absolute(options.dataDir),
    runtime_port: port(options.runtimePort),
    ...(options.webPort === undefined ? {} : { web_port: port(options.webPort) }),
    launch_mode: options.launchMode ?? 'runtime',
    ...(options.runtimeEntry === undefined ? {} : { runtime_entry: options.runtimeEntry }),
  }
  if (config.launch_mode !== 'runtime' && config.launch_mode !== 'development')
    throw new Error('Invalid autostart launch mode.')
  if (
    config.runtime_entry !== undefined &&
    config.runtime_entry !== 'source' &&
    config.runtime_entry !== 'built'
  )
    throw new Error('Invalid autostart runtime entry.')
  const configPath = join(config.data_dir, 'platform-autostart', 'launch.json')
  const identityPath = platform === 'win32' ? config.data_dir.toLowerCase() : config.data_dir
  const id = createHash('sha256').update(identityPath).digest('hex').slice(0, 24)
  const runCommand = options.runCommand ?? runAutostartCommand
  const uid = options.uid ?? process.getuid?.()
  const createBackend = (registeredConfig: AutostartLaunchConfig) =>
    platform === 'win32'
      ? createWindowsAutostart({ config: registeredConfig, configPath, id, runCommand })
      : platform === 'darwin' && uid !== undefined && Number.isInteger(uid) && uid > 0
        ? createMacAutostart({
            config: registeredConfig,
            configPath,
            homeDir: absolute(options.homeDir ?? homedir()),
            id,
            runCommand,
            uid,
          })
        : null
  const base: PlatformAutostartStatus = {
    supported,
    enabled: false,
    platform,
    activation: 'next_login',
  }
  const query = async (): Promise<PlatformAutostartStatus> => {
    if (!supported) return { ...base }
    const configured = await readOwnedAutostartConfig(configPath, config)
    const backend = createBackend(configured ?? config)
    if (!backend) throw new Error('Login startup requires the current non-root GUI user.')
    const registration = await backend.query()
    if (registration.enabled && !configured)
      throw new Error('Registered startup has no valid launch configuration.')
    return { ...base, enabled: registration.enabled }
  }
  let pending: Promise<unknown> = Promise.resolve()
  const serialize = <T>(operation: () => Promise<T>) => {
    const next = pending.then(operation, operation)
    pending = next
    return next
  }
  return {
    getStatus: () =>
      serialize(async () => {
        try {
          return await query()
        } catch (error) {
          return { ...base, error: error instanceof Error ? error.message : String(error) }
        }
      }),
    setEnabled: (enabled: boolean) =>
      serialize(async () => {
        if (!supported) throw new Error('Login startup is not supported for this platform or user.')
        const saved = await readOwnedAutostartConfig(configPath, config)
        const backend = createBackend(saved ?? config)
        if (!backend) throw new Error('Login startup is not supported for this platform or user.')
        await backend.query()
        if (enabled) {
          await access(config.node_executable)
          await access(join(config.project_root, 'scripts', 'platform-start.mjs'))
          await writeAutostartFile(configPath, `${JSON.stringify(config, null, 2)}\n`)
          try {
            await backend.setEnabled(true, config)
          } catch (error) {
            try {
              if (saved) await writeAutostartFile(configPath, `${JSON.stringify(saved, null, 2)}\n`)
              else await rm(configPath, { force: true })
            } catch (restoreError) {
              throw new AggregateError(
                [error, restoreError],
                'Autostart update and config restoration failed.'
              )
            }
            throw error
          }
        } else {
          await backend.setEnabled(false)
        }
        return query()
      }),
  }
}
