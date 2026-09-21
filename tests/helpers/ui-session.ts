import type { Server } from 'node:http'
import type { RuntimeStore } from '../../src/server/runtime-store.js'

const launchers = new Map<string, Pick<RuntimeStore, 'createUiBootstrap'>>()

/** Test-side launcher fixture: production authentication and HTTP exchange stay real. */
export const registerUiLauncher = (server: Server, store: RuntimeStore) => {
  let origin: string | undefined
  server.on('listening', () => {
    const address = server.address()
    if (!address || typeof address === 'string') return
    origin = `http://127.0.0.1:${address.port}`
    launchers.set(origin, store)
  })
  server.on('close', () => {
    if (origin) launchers.delete(origin)
  })
}

export const getUiCookie = async (
  baseUrl: string,
  store = launchers.get(new URL(baseUrl).origin)
) => {
  if (!store) throw new Error('UI test requires a trusted launcher fixture')
  const response = await fetch(`${baseUrl}/api/ui/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bootstrap_token: store.createUiBootstrap() }),
  })
  const cookie = response.headers.get('set-cookie')
  if (!cookie) {
    throw new Error('Expected UI session cookie')
  }
  return cookie
}
