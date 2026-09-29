import { createServer } from 'node:http'
import { spawn } from '@lydell/node-pty'

const worker = `
const { appendFileSync, existsSync, readFileSync } = require('node:fs')
const log = process.env.PLATFORM_PTY_TEST_LOG
const previous = existsSync(log) ? JSON.parse(readFileSync(log, 'utf8').trim().split('\\n').at(-1)) : null
let previousAlive = false
if (previous) {
  try { process.kill(previous.pid, 0); previousAlive = true }
  catch (error) { if (error.code !== 'ESRCH') throw error }
}
appendFileSync(log, JSON.stringify({ pid: process.pid, runtime_pid: Number(process.env.PLATFORM_PTY_RUNTIME_PID), previous_alive: previousAlive }) + '\\n')
process.stdout.write('PLATFORM_PTY_READY')
process.stdin.resume()
setInterval(() => {}, 1000)
`
const server = createServer((_request, response) => response.end(String(process.pid)))
const terminal = spawn(process.execPath, ['-e', worker], {
  name: 'xterm-color',
  cols: 80,
  rows: 24,
  cwd: process.cwd(),
  env: { ...process.env, PLATFORM_PTY_RUNTIME_PID: String(process.pid) },
})
let output = ''
let listening = false
let stopping = false
terminal.onData((chunk) => {
  output += chunk
  if (listening || !output.includes('PLATFORM_PTY_READY')) return
  listening = true
  server.listen(0, '127.0.0.1', () => {
    process.send({ type: 'hive:runtime-ready', port: server.address().port })
  })
})
terminal.onExit(() => {
  if (!stopping) process.exit(17)
  server.close(() => process.exit(0))
})
process.on('SIGTERM', () => {
  stopping = true
  terminal.kill()
})
