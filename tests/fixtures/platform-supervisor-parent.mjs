import { fileURLToPath } from 'node:url'
import { createPlatformSupervisor } from '../../scripts/platform-supervisor.mjs'

const supervisor = createPlatformSupervisor({
  services: [
    {
      name: 'runtime',
      command: process.execPath,
      args: [
        fileURLToPath(new URL('../../scripts/managed-node.mjs', import.meta.url)),
        fileURLToPath(new URL('./platform-service.mjs', import.meta.url)),
      ],
      env: process.env,
    },
  ],
})
process.on('message', (message) => {
  if (message?.type === 'fixture:crash-parent') process.exit(42)
  if (message?.type === 'fixture:stop-parent') void supervisor.stop().then(() => process.exit(0))
})
await supervisor.start()
process.send({ type: 'fixture:parent-ready', pid: supervisor.getChild('runtime').pid })
