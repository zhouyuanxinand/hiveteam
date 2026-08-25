#!/usr/bin/env node

import { once } from 'node:events'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { createAgentManager } from '../server/agent-manager.js'
import { createApp } from '../server/app.js'
import { readPackageVersion } from '../server/package-version.js'
import { createRemoteTunnel } from '../server/remote-tunnel.js'
import { createRuntimeStore, type RuntimeStore } from '../server/runtime-store.js'
import { resolveDataDir } from './hive-data-dir.js'
import { DEFAULT_HIVE_PORT } from './hive-defaults.js'
import { runHiveRemoteCommand } from './hive-remote.js'
import { runHiveUpdateCommand } from './hive-update.js'

interface RunHiveCommandResult {
  port: number
  close: () => Promise<void>
  store: RuntimeStore
}

type ListenError = Error & {
  address?: string
  code?: string
  port?: number
}

export const HIVE_USAGE = [
  'Usage:',
  '  hive [--port <port>]',
  '  hive update',
  '',
  'Options:',
  `  --port <port>   Bind the local runtime to a specific port (default: ${DEFAULT_HIVE_PORT}).`,
  '  -h, --help      Print this help.',
  '  -v, --version   Print the installed Hive version.',
  '',
  'Commands:',
  '  remote         Link and manage remote access devices.',
  '  update          Explain how to update this source-controlled build.',
].join('\n')

export const handleHiveInfoCommand = (argv: string[]) => {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HIVE_USAGE)
    return true
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    console.log(readPackageVersion())
    return true
  }
  return false
}

export const parseHivePort = (argv: string[]) => {
  let parsedPort: number | null = null

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg !== '--port') {
      if (arg?.startsWith('-')) throw new Error(`Unknown option: ${arg}`)
      if (arg) throw new Error(`Unknown argument: ${arg}`)
      continue
    }

    const value = argv[index + 1]
    if (!value) {
      throw new Error('Usage: hive [--port <port>]')
    }

    const port = Number.parseInt(value, 10)
    if (Number.isNaN(port) || port < 0) {
      throw new Error(`Invalid port: ${value}`)
    }

    parsedPort = port
    index += 1
  }

  return parsedPort ?? DEFAULT_HIVE_PORT
}

export { resolveDataDir }

const isListenError = (error: unknown): error is ListenError =>
  error instanceof Error && typeof (error as ListenError).code === 'string'

const formatPortInUseMessage = (port: number) =>
  [
    `Hive could not start because port ${port} is already in use.`,
    '',
    'Another Hive instance may already be running:',
    `  http://127.0.0.1:${port}`,
    '',
    'Options:',
    '  - Open the existing Hive window.',
    '  - Stop the process using that port:',
    `      lsof -tiTCP:${port} -sTCP:LISTEN | xargs kill`,
    '  - Start Hive on another port:',
    `      hive --port ${port + 1}`,
  ].join('\n')

const formatListenError = (error: unknown, requestedPort: number) => {
  if (isListenError(error) && error.code === 'EADDRINUSE') {
    return new Error(formatPortInUseMessage(error.port ?? requestedPort))
  }
  return error
}

export const runHiveCommand = async (argv: string[]): Promise<RunHiveCommandResult> => {
  const port = parseHivePort(argv)
  const dataDir = resolveDataDir()
  const app = createApp({
    store: createRuntimeStore({
      agentManager: createAgentManager(),
      dataDir,
    }),
  })

  try {
    app.server.listen(port, '127.0.0.1')
    await Promise.race([
      once(app.server, 'listening'),
      once(app.server, 'error').then(([error]) => {
        throw error
      }),
    ])
  } catch (error) {
    await app.store.close()
    throw formatListenError(error, port)
  }

  const address = app.server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Server did not bind to an inet port')
  }

  const remoteTunnel = createRemoteTunnel({
    loopbackPort: address.port,
    config: app.store.remote.config,
    deviceSessions: app.store.remote.sessions,
    loopbackSecret: app.store.getRemoteTunnelSecret(),
    audit: app.store.remote.audit,
    pairing: app.store.remote.pairing,
    onStatus: (event) => {
      if (event.status === 'reconnecting') {
        console.warn(
          `[hive] remote tunnel reconnecting${event.nextRetryInMs === undefined ? '' : ` in ${event.nextRetryInMs}ms`}: ${event.reason ?? 'connection lost'}`
        )
      }
    },
  })
  app.store.remote.setTunnel(remoteTunnel)
  remoteTunnel.refresh()

  let closePromise: Promise<void> | null = null
  const close = async () => {
    if (closePromise) {
      return closePromise
    }

    closePromise = (async () => {
      process.off('SIGTERM', gracefulShutdown)
      process.off('SIGINT', gracefulShutdown)
      await remoteTunnel.close()
      await new Promise<void>((resolve, reject) => {
        app.server.close((error) => {
          if (error) {
            reject(error)
            return
          }

          resolve()
        })
      })
      await app.store.close()
      app.store.remote.setTunnel(null)
    })()

    return closePromise
  }

  const gracefulShutdown = () => {
    void close()
      .then(() => {
        process.exit(0)
      })
      .catch((error) => {
        console.error(error)
        process.exit(1)
      })
  }

  process.once('SIGTERM', gracefulShutdown)
  process.once('SIGINT', gracefulShutdown)

  console.log(`Hive running at http://127.0.0.1:${address.port}`)
  void app.store
    .autoResumeInterruptedAgents({ hivePort: String(address.port) })
    .catch((error) => console.error('[hive] auto-resume bootstrap failed', error))

  return {
    port: address.port,
    close,
    store: app.store,
  }
}

export type { RunHiveCommandResult }

const isMainModule = process.argv[1]
  ? fileURLToPath(import.meta.url) === realpathSync(process.argv[1])
  : false

if (isMainModule) {
  const argv = process.argv.slice(2)
  if (argv[0] === 'remote') {
    runHiveRemoteCommand(argv.slice(1))
      .then((code) => process.exit(code))
      .catch((error) => {
        console.error(error)
        process.exit(1)
      })
  } else if (argv[0] === 'update') {
    runHiveUpdateCommand(argv.slice(1))
      .then((code) => process.exit(code))
      .catch((error) => {
        console.error(error)
        process.exit(1)
      })
  } else if (handleHiveInfoCommand(argv)) {
    process.exit(0)
  } else {
    runHiveCommand(argv).catch((error) => {
      console.error(error instanceof Error ? error.message : error)
      process.exit(1)
    })
  }
}
