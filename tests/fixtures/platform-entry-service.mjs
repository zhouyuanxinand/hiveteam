import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'

export const start = (entry) => {
  const server = createServer((request, response) => {
    if (request.url !== '/launch-config') {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ entry, pid: process.pid, exec_argv: process.execArgv }))
      return
    }
    const requestId = randomUUID()
    const receive = (message) => {
      if (message?.type !== 'hive:platform-status-result' || message.request_id !== requestId)
        return
      clearTimeout(timeout)
      process.off('message', receive)
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(message.launch_config))
    }
    const timeout = setTimeout(() => {
      process.off('message', receive)
      response.writeHead(504).end()
    }, 3000)
    process.on('message', receive)
    process.send({ type: 'hive:platform-status', request_id: requestId })
  })
  process.on('message', (message) => {
    if (message?.type === 'hive:create-ui-bootstrap')
      process.send({
        type: 'hive:ui-bootstrap',
        request_id: message.request_id,
        bootstrap_token: entry,
      })
  })
  process.on('SIGTERM', () => server.close(() => process.exit(0)))
  server.listen(Number(process.env.HIVE_RUNTIME_PORT), '127.0.0.1', () => {
    process.send({ type: 'hive:runtime-ready', port: server.address().port })
  })
}
