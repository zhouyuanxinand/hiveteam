import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'

/** Requests cross only the inherited parent/child IPC channel, never HTTP. */
export const requestUiBootstrap = (child) =>
  new Promise((resolve, reject) => {
    const requestId = randomUUID()
    const timeout = setTimeout(() => fail(), 10_000)
    const cleanup = () => {
      clearTimeout(timeout)
      child.off('message', receive)
      child.off('exit', fail)
      child.off('disconnect', fail)
    }
    const fail = () => {
      cleanup()
      reject(new Error('The HiveTeam runtime could not authenticate the launcher'))
    }
    const receive = (message) => {
      if (
        message?.type !== 'hive:ui-bootstrap' ||
        message.request_id !== requestId ||
        typeof message.bootstrap_token !== 'string'
      )
        return
      cleanup()
      resolve(message.bootstrap_token)
    }
    child.on('message', receive)
    child.once('exit', fail)
    child.once('disconnect', fail)
    if (!child.connected) return fail()
    child.send({ type: 'hive:create-ui-bootstrap', request_id: requestId }, (error) => {
      if (error) fail()
    })
  })

export const createUiLaunchUrl = async (child, origin) => {
  const url = new URL(origin)
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('The UI launcher requires a loopback HTTP origin')
  }
  url.hash = new URLSearchParams({ hive_bootstrap: await requestUiBootstrap(child) }).toString()
  return url.href
}

export const openUiBrowser = (url) =>
  new Promise((resolve, reject) => {
    const [command, args] =
      process.platform === 'win32'
        ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
        : process.platform === 'darwin'
          ? ['open', [url]]
          : ['xdg-open', [url]]
    execFile(command, args, { windowsHide: true }, (error) => {
      if (error) reject(new Error('Could not open the browser. Use the HiveTeam desktop launcher.'))
      else resolve()
    })
  })
