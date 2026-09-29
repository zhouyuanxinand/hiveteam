import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { isAbsolute, resolve } from 'node:path'
import { promisify } from 'node:util'

import { createPlatformEnvironment } from './platform-environment.mjs'
import { acquirePlatformOwner } from './platform-owner.mjs'
import { createPlatformSupervisor } from './platform-supervisor.mjs'
import { createUiLaunchUrl, requestUiBootstrap } from './ui-launcher.mjs'

export const launchPlatform = async ({
  projectRoot,
  nodeExecutable = process.execPath,
  dataDir,
  runtimePort,
  runtimeEntry,
  webPort,
  launchMode = 'runtime',
  environment = process.env,
  signal,
}) => {
  if (!isAbsolute(nodeExecutable)) {
    const result = await promisify(execFile)(nodeExecutable, ['-p', 'process.execPath'], {
      env: environment,
      windowsHide: true,
    })
    nodeExecutable = result.stdout.trim()
  }
  signal?.throwIfAborted()
  const source = resolve(projectRoot, 'src/cli/hive.ts')
  const built = resolve(projectRoot, 'dist/src/cli/hive.js')
  if (
    runtimeEntry !== undefined &&
    (!isAbsolute(runtimeEntry) || ![source, built].includes(resolve(runtimeEntry)))
  )
    throw new Error('Invalid runtime entry: expected this installation’s source or built CLI')
  const entry =
    runtimeEntry === undefined ? (existsSync(source) ? source : built) : resolve(runtimeEntry)
  if (!existsSync(entry)) throw new Error('HiveTeam runtime entry was not found')
  if (launchMode === 'development' && (!webPort || !runtimePort || webPort === runtimePort)) {
    throw new Error('Development mode needs distinct, nonzero runtime and web ports')
  }
  signal?.throwIfAborted()
  const owner = acquirePlatformOwner(dataDir)
  try {
    for (const port of [runtimePort, ...(launchMode === 'development' ? [webPort] : [])]) {
      if (!port) continue
      const probe = createServer()
      await new Promise((resolveReady, reject) => {
        probe.once('error', reject)
        probe.listen(port, '127.0.0.1', () =>
          probe.close((error) => {
            if (error) reject(error)
            else resolveReady()
          })
        )
      })
    }
    signal?.throwIfAborted()
  } catch (error) {
    owner.close()
    throw error
  }
  const config = {
    project_root: projectRoot,
    node_executable: nodeExecutable,
    data_dir: owner.dataDir,
    runtime_port: runtimePort,
    runtime_entry: entry === source ? 'source' : 'built',
    ...(launchMode === 'development' ? { web_port: webPort } : {}),
    launch_mode: launchMode,
  }
  const env = {
    ...createPlatformEnvironment(environment, nodeExecutable),
    HIVE_DATA_DIR: owner.dataDir,
    HIVE_RUNTIME_PORT: String(runtimePort),
    ...(webPort ? { HIVE_WEB_PORT: String(webPort) } : {}),
    HIVE_MANAGED_RUNTIME: '1',
  }
  const wrapper = resolve(projectRoot, 'scripts/managed-node.mjs')
  const services = [
    {
      name: 'runtime',
      command: nodeExecutable,
      args: [
        ...(entry === source ? ['--import', 'tsx'] : []),
        wrapper,
        entry,
        '--port',
        String(runtimePort),
      ],
      cwd: projectRoot,
      env,
    },
  ]
  if (launchMode === 'development')
    services.push({
      name: 'web',
      command: nodeExecutable,
      args: [
        wrapper,
        resolve(projectRoot, 'node_modules/vite/bin/vite.js'),
        '--config',
        resolve(projectRoot, 'web/vite.config.ts'),
      ],
      cwd: projectRoot,
      env,
      readyUrl: `http://127.0.0.1:${webPort}/`,
    })
  const supervisor = createPlatformSupervisor({ services })
  const runtime = () => {
    const child = supervisor.getChild('runtime')
    if (!child?.connected) throw new Error('HiveTeam runtime is restarting')
    return child
  }
  let stopPromise
  const stop = () => {
    stopPromise ??= supervisor.stop().then(() => {
      signal?.removeEventListener('abort', abort)
      owner.close()
    })
    return stopPromise
  }
  const abort = () => {
    void stop().catch((error) => console.error('[HiveTeam] Stop failed:', error.message))
  }
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) {
    await stop()
    signal.throwIfAborted()
  }
  supervisor.onReady(() => {
    const child = runtime()
    child.on('message', (message) => {
      if (
        message?.type !== 'hive:platform-status' ||
        typeof message.request_id !== 'string' ||
        message.request_id.length > 128 ||
        !child.connected
      )
        return
      child.send(
        {
          type: 'hive:platform-status-result',
          request_id: message.request_id,
          status: supervisor.getStatus(),
          launch_config: { ...config, runtime_port: supervisor.getPort('runtime') ?? runtimePort },
        },
        (error) => {
          if (error) console.error('[HiveTeam] Supervisor status delivery failed:', error.message)
        }
      )
    })
  })
  try {
    await supervisor.start()
  } catch (error) {
    await stop()
    throw error
  }
  const runtimeOrigin = () => `http://127.0.0.1:${supervisor.getPort('runtime') ?? runtimePort}`
  const appOrigin = () =>
    launchMode === 'development' ? `http://127.0.0.1:${webPort}` : runtimeOrigin()
  return {
    supervisor,
    get appOrigin() {
      return appOrigin()
    },
    get runtimeOrigin() {
      return runtimeOrigin()
    },
    createLaunchUrl: () => createUiLaunchUrl(runtime(), appOrigin()),
    requestUiBootstrap: () => requestUiBootstrap(runtime()),
    stop,
  }
}
