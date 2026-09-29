import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// A real PTY editor fixture: only a submitted draft produces a native session
// receipt. No team command or HTTP handoff is called by this process.
const root = process.env.GRILL_TERMINAL_FIXTURE_ROOT
const agent = process.env.HIVE_AGENT_ID.replaceAll(':', '_')
const sessionId = randomUUID()
const sessions = join(process.env.CODEX_HOME, 'sessions')
mkdirSync(sessions, { recursive: true })
const history = join(sessions, `rollout-${sessionId}.jsonl`)
writeFileSync(
  history,
  `${JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd: process.cwd() } })}\n${JSON.stringify({ binding: `Hive session binding: workspace_id=${process.env.HIVE_PROJECT_ID}; agent_id=${process.env.HIVE_AGENT_ID}` })}\n`
)
const rawFile = join(root, `${agent}.raw`)
const submissions = join(root, `${agent}.submitted.jsonl`)
writeFileSync(rawFile, '')
writeFileSync(submissions, '')
const recordSubmission = (text) => {
  appendFileSync(submissions, `${JSON.stringify({ text })}\n`)
  appendFileSync(
    history,
    `${JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: text } })}\n`
  )
}
const promptIndex = process.argv.indexOf('--', 2)
const initialPrompt = promptIndex >= 0 ? process.argv[promptIndex + 1] : undefined
if (initialPrompt) recordSubmission(initialPrompt)
let draft = ''
let pending = ''
let pasting = false
let ready = process.env.GRILL_TERMINAL_DEFER_READY !== '1'
const render = () => {
  if (!ready) {
    process.stdout.write('\u001b[2J\u001b[HFIXTURE_BOOTING\r\n')
    return
  }
  const input =
    draft.includes('\n') || draft.length > 120
      ? `[Pasted Content ${draft.length} chars]`
      : draft || 'Ask Codex to do anything'
  process.stdout.write(`\u001b[2J\u001b[HFIXTURE_READY\r\n› ${input}\r\n`)
}
process.stdin.setRawMode(true)
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  appendFileSync(rawFile, chunk)
  pending += chunk
  while (pending.length) {
    // Native Codex consumes xterm focus/device replies without editing its draft.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Native terminal device replies.
    const reply = /^(?:\u001b\[[IO]|\u001b\[[?>]?[\d;]*c)/u.exec(pending)?.[0]
    if (reply) {
      pending = pending.slice(reply.length)
      continue
    }
    if (pending.startsWith('\u001b[200~')) {
      pasting = true
      pending = pending.slice(6)
      continue
    }
    if (pending.startsWith('\u001b[201~')) {
      pasting = false
      pending = pending.slice(6)
      continue
    }
    if (pending.startsWith('\u001b[C')) {
      pending = pending.slice(3)
      continue
    }
    if (pending[0] === '\u001b' && pending.length < 6) break
    const key = pending[0]
    pending = pending.slice(1)
    if (pasting) {
      draft += key
      continue
    }
    if (key === '\u0005') continue
    if (key === '\u0015') {
      draft = ''
      continue
    }
    if (key === '\u007f' || key === '\b') {
      draft = draft.slice(0, -1)
      continue
    }
    if (key === '\r' || key === '\n') {
      if (draft) recordSubmission(draft)
      draft = ''
    } else draft += key
  }
  render()
})
render()
if (!ready) {
  const timer = setInterval(() => {
    if (!existsSync(join(root, 'show-composer'))) return
    clearInterval(timer)
    ready = true
    render()
  }, 25)
}
process.stdin.resume()
