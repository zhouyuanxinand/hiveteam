import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const entry = process.argv[2]
if (!entry) throw new Error('Managed Node requires an entry module')
process.argv = [process.execPath, resolve(entry), ...process.argv.slice(3)]
let stopping = false
const shutdown = () => {
  if (stopping) return
  stopping = true
  if (process.listenerCount('SIGTERM') === 0) process.exit(0)
  // Also bounds cleanup when the supervisor itself has disappeared.
  setTimeout(() => process.exit(1), 5000).unref()
  process.emit('SIGTERM')
}
process.on('disconnect', shutdown)
process.on('message', (message) => {
  if (message?.type === 'hive:shutdown') shutdown()
  if (message?.type === 'hive:ping' && typeof message.request_id === 'string' && process.connected)
    process.send({ type: 'hive:pong', request_id: message.request_id }, (error) => {
      if (error) shutdown()
    })
})
await import(pathToFileURL(process.argv[1]).href)
