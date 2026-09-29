import { appendFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if (resolve(process.argv[1]) !== fileURLToPath(import.meta.url))
  throw new Error('Entry argv was not preserved')

const log = (event) => {
  if (process.env.SUPERVISOR_TEST_LOG)
    appendFileSync(
      process.env.SUPERVISOR_TEST_LOG,
      `${JSON.stringify({ event, pid: process.pid })}\n`
    )
}
log('started')
if (process.env.SUPERVISOR_TEST_EXIT_ON_START === '1') process.exit(7)
const server = createServer((_request, response) => {
  if (process.env.SUPERVISOR_TEST_HANG_HTTP === '1') return
  response.writeHead(healthy ? 200 : 503)
  response.end(String(process.pid))
})
let healthy = true
if (process.env.SUPERVISOR_TEST_NO_HANDLER !== '1')
  process.on('SIGTERM', () => {
    log('shutdown')
    server.close(() => process.exit(0))
  })
process.on('message', (message) => {
  if (message?.type === 'fixture:crash') process.exit(7)
  if (message?.type === 'fixture:hang') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
  if (message?.type === 'fixture:unhealthy') healthy = false
  if (message?.type === 'hive:create-ui-bootstrap')
    process.send({
      type: 'hive:ui-bootstrap',
      request_id: message.request_id,
      bootstrap_token: String(process.pid),
    })
})
server.listen(Number(process.env.SUPERVISOR_TEST_PORT ?? 0), '127.0.0.1', () => {
  if (process.env.SUPERVISOR_TEST_NEVER_READY !== '1')
    process.send({ type: 'hive:runtime-ready', port: server.address().port })
})
