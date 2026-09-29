import { randomUUID } from 'node:crypto'

import type { PlatformRecoveryView } from '../shared/platform-recovery.js'
import { createPlatformAutostart } from './platform-autostart.js'

interface LaunchConfig {
  project_root: string
  node_executable: string
  data_dir: string
  runtime_port: number
  web_port?: number
  launch_mode: 'runtime' | 'development'
  runtime_entry?: 'source' | 'built'
}
interface SupervisorReply {
  status: NonNullable<PlatformRecoveryView['supervision']>
  launch_config: LaunchConfig
}

const managed = () => process.env.HIVE_MANAGED_RUNTIME === '1' && process.connected
const readSupervisor = (): Promise<SupervisorReply> =>
  new Promise((resolve, reject) => {
    const requestId = randomUUID()
    const cleanup = () => {
      clearTimeout(timeout)
      process.off('message', receive)
      process.off('disconnect', disconnected)
    }
    const failed = (error: Error) => {
      cleanup()
      reject(error)
    }
    const disconnected = () => failed(new Error('Platform supervisor disconnected'))
    const receive = (message: unknown) => {
      if (
        !message ||
        typeof message !== 'object' ||
        !('type' in message) ||
        message.type !== 'hive:platform-status-result' ||
        !('request_id' in message) ||
        message.request_id !== requestId
      )
        return
      cleanup()
      resolve(message as SupervisorReply & { type: string; request_id: string })
    }
    const timeout = setTimeout(() => failed(new Error('Platform supervisor did not respond')), 3000)
    process.on('message', receive)
    process.once('disconnect', disconnected)
    if (!process.send || !process.connected) {
      disconnected()
      return
    }
    process.send({ type: 'hive:platform-status', request_id: requestId }, (error: Error | null) => {
      if (error) failed(error)
    })
  })

let registration: { key: string; service: ReturnType<typeof createPlatformAutostart> } | undefined
const autostart = (config: LaunchConfig) => {
  const key = JSON.stringify(config)
  if (registration?.key === key) return registration.service
  const service = createPlatformAutostart({
    dataDir: config.data_dir,
    projectRoot: config.project_root,
    nodeExecutable: config.node_executable,
    runtimePort: config.runtime_port,
    ...(config.web_port === undefined ? {} : { webPort: config.web_port }),
    launchMode: config.launch_mode,
    ...(config.runtime_entry === undefined ? {} : { runtimeEntry: config.runtime_entry }),
  })
  registration = { key, service }
  return service
}

export const getPlatformRecoveryStatus = async (): Promise<PlatformRecoveryView> => {
  if (!managed())
    return {
      managed: false,
      supervision: null,
      auto_start: { supported: false, enabled: false, platform: process.platform },
    }
  const reply = await readSupervisor()
  return {
    managed: true,
    supervision: reply.status,
    auto_start: await autostart(reply.launch_config).getStatus(),
  }
}

export const setPlatformAutostart = async (enabled: boolean): Promise<PlatformRecoveryView> => {
  if (!managed())
    throw new Error('Start HiveTeam through its platform launcher to configure login startup.')
  const reply = await readSupervisor()
  return {
    managed: true,
    supervision: reply.status,
    auto_start: await autostart(reply.launch_config).setEnabled(enabled),
  }
}
