import { execFile } from 'node:child_process'

import type { RuntimeStore } from '../server/runtime-store.js'

const openBrowser = (url: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const [command, args] =
      process.platform === 'win32'
        ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
        : process.platform === 'darwin'
          ? ['open', [url]]
          : ['xdg-open', [url]]
    execFile(command, args, { windowsHide: true }, (error) => {
      // The OS error includes argv (and therefore the one-time token).
      if (error) reject(new Error('Could not open the browser. Use the Hive desktop launcher.'))
      else resolve()
    })
  })

/** The inherited IPC channel is owned by the launcher, never by HTTP clients. */
export const installUiLauncher = (store: RuntimeStore, port: number) => {
  const handleMessage = (message: unknown) => {
    if (!message || typeof message !== 'object') return
    if (!('type' in message) || message.type !== 'hive:create-ui-bootstrap') return
    if (!('request_id' in message) || typeof message.request_id !== 'string') return
    if (message.request_id.length > 128) return
    process.send?.({
      type: 'hive:ui-bootstrap',
      request_id: message.request_id,
      bootstrap_token: store.createUiBootstrap(),
    })
  }
  const reopen = () => {
    const url = `http://127.0.0.1:${port}/#hive_bootstrap=${store.createUiBootstrap()}`
    void openBrowser(url).catch((error: Error) => console.error(`[hive] ${error.message}`))
  }
  const handleInput = (input: Buffer) => {
    if (input.toString().trim().toLowerCase() === 'o') reopen()
  }

  if (process.send) {
    process.on('message', handleMessage)
  } else {
    reopen()
    if (process.stdin.isTTY) {
      console.log('[hive] Enter o to reopen an authenticated browser window.')
      process.stdin.on('data', handleInput)
    }
  }
  return () => {
    process.off('message', handleMessage)
    process.stdin.off('data', handleInput)
  }
}
