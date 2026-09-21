// Synthetic native CLI only: never uses model credentials, vendors or network.
const { randomUUID } = require('node:crypto')
const { execSync } = require('node:child_process')
const fs = require('node:fs')
const { join, dirname } = require('node:path')
const { createInterface } = require('node:readline')
const args = process.argv.slice(2)
const value = (flag) => args[args.indexOf(flag) + 1]
const root = value('--fixture-root'),
  harness = value('--fixture-harness')
const modePath = join(root, 'mode.json')
const mode = fs.existsSync(modePath) ? JSON.parse(fs.readFileSync(modePath, 'utf8')) : {}
const encoded = encodeURIComponent(fs.realpathSync(process.cwd())).replace(
  /[!'()*]/g,
  (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
)
const file = (id) =>
  harness === 'cursor'
    ? join(root, '.cursor', id, 'fixture.json')
    : join(root, '.grok', 'sessions', encoded, id, 'summary.json')
const save = (id, messages = []) => {
  fs.mkdirSync(dirname(file(id)), { recursive: true })
  fs.writeFileSync(
    file(id),
    JSON.stringify({ info: { id, cwd: fs.realpathSync(process.cwd()) }, messages })
  )
}
fs.appendFileSync(
  join(root, 'invocations.jsonl'),
  `${JSON.stringify({ harness, args, pid: process.pid, cwd: process.cwd() })}\n`
)
if (args.includes('create-chat')) {
  const id = mode.duplicate_id || randomUUID()
  save(id)
  if (mode.allocation_delay)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, mode.allocation_delay)
  if (mode.allocation_failure) process.exit(2)
  process.stdout.write(`${id}\n`)
  process.exit(0)
}
if (args.includes('acp')) {
  createInterface({ input: process.stdin }).on('line', (line) => {
    const request = JSON.parse(line)
    if (request.method === 'initialize')
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
        })}\n`
      )
    else if (request.method === 'session/load') {
      const code = mode.denied
        ? -32000
        : !fs.existsSync(file(request.params.sessionId))
          ? -32002
          : null
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          ...(code ? { error: { code, message: 'Synthetic native failure' } } : { result: {} }),
        })}\n`
      )
    } else process.exit(9)
  })
} else {
  const fresh = args.includes('--session-id')
  const id = value(fresh ? '--session-id' : '--resume')
  if (!id) process.exit(3)
  if (fresh) {
    if (fs.existsSync(file(id))) process.exit(4)
    save(id)
  }
  if (!fs.existsSync(file(id))) process.exit(5)
  const plugin = value('--plugin-dir')
  const hooks = JSON.parse(fs.readFileSync(join(plugin, 'hooks/hooks.json'), 'utf8')).hooks
  const observedId = mode.wrong_identity ? randomUUID() : id
  const event =
    harness === 'cursor'
      ? {
          hook_event_name: 'sessionStart',
          session_id: observedId,
          conversation_id: observedId,
          workspace_roots: [process.cwd()],
        }
      : {
          hookEventName: 'session_start',
          sessionId: observedId,
          cwd: process.cwd(),
          workspaceRoot: process.cwd(),
          source: fresh ? 'startup' : 'resume',
        }
  const command =
    harness === 'cursor' ? hooks.sessionStart[0].command : hooks.SessionStart[0].hooks[0].command
  execSync(command, {
    input: JSON.stringify(event),
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const history = JSON.parse(fs.readFileSync(file(id), 'utf8'))
  process.stdout.write(
    `NATIVE:${id}\nHISTORY:${history.messages.join('|')}\n${mode.permission_dialog ? 'Allow command? [y/n]' : mode.draft ? 'Existing human draft' : 'Synthetic terminal ready'}\n`
  )
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    const data = JSON.parse(fs.readFileSync(file(id), 'utf8'))
    data.messages.push(chunk)
    fs.writeFileSync(file(id), JSON.stringify(data))
    process.stdout.write(`INPUT:${chunk}\n`)
  })
  setInterval(() => {}, 1000)
}
