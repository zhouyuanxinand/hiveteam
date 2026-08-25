import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import './styles/globals.css'
import { RemoteGate } from './remote/RemoteGate.js'
import { installRemoteTransport, RemoteClient } from './remote/remote-client.js'
import './remote/remote-gate.css'

const container = document.getElementById('root')

if (!container) throw new Error('Root element not found')

const client = new RemoteClient()
const root = createRoot(container)

const openHive = async () => {
  ;(window as Window & { __HIVE_REMOTE_MODE__?: boolean }).__HIVE_REMOTE_MODE__ = true
  document.body.dataset.hiveRemote = 'true'
  installRemoteTransport(client)
  const { App } = await import('./app.js')
  root.render(
    <StrictMode>
      <App />
    </StrictMode>
  )
}

root.render(
  <StrictMode>
    <RemoteGate client={client} onConnected={openHive} />
  </StrictMode>
)
