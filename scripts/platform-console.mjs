import { launchPlatform } from './platform-launch.mjs'
import { PlatformAlreadyRunningError } from './platform-owner.mjs'
import { PlatformRestartLimitError } from './platform-supervisor.mjs'
import { openUiBrowser } from './ui-launcher.mjs'

export const runPlatformConsole = async (options) => {
  const controller = new AbortController()
  let platform
  let launching
  let stopping = false
  const shutdown = async () => {
    if (stopping) return
    stopping = true
    controller.abort()
    await platform?.stop()
    process.stdin.pause()
    process.off('SIGINT', onShutdown)
    process.off('SIGTERM', onShutdown)
    process.off('disconnect', onShutdown)
    process.off('message', onMessage)
    if (process.connected) process.disconnect()
  }
  const onShutdown = () => {
    void shutdown().catch((error) => {
      console.error('[HiveTeam] Shutdown failed:', error)
      process.exitCode = 1
    })
  }
  const onMessage = (message) => {
    if (message?.type === 'hive:shutdown') {
      onShutdown()
      return
    }
    if (
      message?.type !== 'hive:create-ui-bootstrap' ||
      typeof message.request_id !== 'string' ||
      message.request_id.length > 128
    )
      return
    void launching
      .then((current) => current.requestUiBootstrap())
      .then((token) => {
        if (process.connected)
          process.send({
            type: 'hive:ui-bootstrap',
            request_id: message.request_id,
            bootstrap_token: token,
          })
      })
      .catch((error) => console.error('[HiveTeam] UI launch failed:', error.message))
  }
  process.once('SIGINT', onShutdown)
  process.once('SIGTERM', onShutdown)
  process.once('disconnect', onShutdown)
  process.on('message', onMessage)
  console.log(`[HiveTeam] Data directory: ${options.dataDir}`)
  launching = launchPlatform({ ...options, signal: controller.signal })
  try {
    platform = await launching
  } catch (error) {
    const cancelled = controller.signal.aborted
    await shutdown()
    if (cancelled) return
    if (
      error instanceof PlatformAlreadyRunningError ||
      error instanceof PlatformRestartLimitError
    ) {
      console.log(`[HiveTeam] ${error.message}`)
      return
    }
    throw error
  }
  if (stopping) {
    await platform.stop()
    return
  }
  const open = () =>
    platform
      .createLaunchUrl()
      .then(openUiBrowser)
      .catch((error) => console.error('[HiveTeam] Could not open browser:', error.message))
  platform.supervisor.onReady(() => {
    console.log('[HiveTeam] Platform recovered; existing workspaces are being restored.')
    if (!process.send) void open()
  })
  platform.supervisor.onFailed((status) => {
    console.error('[HiveTeam] Automatic recovery stopped:', status.last_error)
    // A controlled circuit-breaker stop must not trigger another OS KeepAlive loop.
    void shutdown()
  })
  if (!process.send) {
    await open()
    if (process.stdin.isTTY)
      process.stdin.on('data', (input) => {
        if (input.toString().trim().toLowerCase() === 'o') void open()
      })
  }
}
