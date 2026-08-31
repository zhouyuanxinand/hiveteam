import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAgentManager } from '../../src/server/agent-manager.js'
import { createApp } from '../../src/server/app.js'
import { probeDirectory } from '../../src/server/fs-browse.js'
import type { PickFolderResponse } from '../../src/server/fs-pick-folder.js'
import type { OpenWorkspaceService } from '../../src/server/route-types.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'

interface TestServerContext {
  baseUrl: string
  close: () => Promise<void>
  dataDir: string
  store: ReturnType<typeof createRuntimeStore>
}

// Fetch follows the browser blocked-port list even when the caller is Node.
// Windows can assign one of those ports to listen(0), which makes an otherwise
// healthy test server fail with `TypeError: bad port`. Rebind until the chosen
// ephemeral port is usable by both fetch and WebSocket clients.
const FETCH_BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6697, 10080,
])

export const listenOnFetchSafePort = async (server: ReturnType<typeof createApp>['server']) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error)
      server.once('error', onError)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', onError)
        resolve()
      })
    })

    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Server did not bind to an inet port')
    }
    if (!FETCH_BLOCKED_PORTS.has(address.port)) return address.port

    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  }

  throw new Error('Could not allocate a fetch-safe test server port')
}

export const startTestServer = async (
  input: {
    dataDir?: string
    openWorkspaceService?: OpenWorkspaceService
    pickFolderPath?: string
    pickFolderService?: () => Promise<PickFolderResponse>
  } = {}
): Promise<TestServerContext> => {
  const ownsDataDir = !input.dataDir
  const dataDir = input.dataDir ?? mkdtempSync(join(tmpdir(), 'hive-test-server-'))
  const store = createRuntimeStore({ agentManager: createAgentManager(), dataDir })
  const pickFolderService =
    input.pickFolderService ??
    (input.pickFolderPath
      ? async () => ({
          canceled: false,
          error: null,
          path: input.pickFolderPath ?? null,
          probe: input.pickFolderPath ? await probeDirectory(input.pickFolderPath) : null,
          supported: true,
        })
      : undefined)
  const app = createApp({
    ...(input.openWorkspaceService ? { openWorkspaceService: input.openWorkspaceService } : {}),
    ...(pickFolderService ? { pickFolderService } : {}),
    store,
  })

  const port = await listenOnFetchSafePort(app.server)

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    async close() {
      await store.close()
      await new Promise<void>((resolve) => app.server.close(() => resolve()))
      if (ownsDataDir) rmSync(dataDir, { force: true, recursive: true })
    },
    dataDir,
    store,
  }
}
