import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2).filter((arg) => arg !== '--no-daemon')
const resumed = args[0] === 'resume'
const id = resumed ? args[1] : randomUUID()
const root = args.at(-1)
mkdirSync(join(root, 'sessions'), { recursive: true })
const path = join(root, 'sessions', `rollout-${id}.jsonl`)
const row = (type, payload) => `${JSON.stringify({ type, payload })}\n`
if (!resumed) writeFileSync(path, row('session_meta', { id, cwd: process.cwd() }))
else if (!existsSync(path)) throw new Error('Requested session does not exist')
const journal = join(root, 'launch.json')
writeFileSync(journal, JSON.stringify({ id, resumed, accepted: 0 }))
// Paint with cursor addressing only, as native full-screen TUIs do.
const prompt = (text = 'Ask Codex to do anything') =>
  process.stdout.write(`\x1b[2J\x1b[HOpenAI Codex\x1b[20;1H› ${text}`)
process.stdin.setRawMode(true)
process.stdin.setEncoding('utf8')
let input = ''
let pending = ''
prompt()
process.stdin.on('data', (chunk) => {
  if (chunk.includes('\x03')) process.exit(0)
  input += chunk
  const start = input.indexOf('\x1b[200~')
  const end = input.indexOf('\x1b[201~')
  if (start >= 0 && end > start) {
    pending = input.slice(start + 6, end)
    input = input.slice(end + 6)
    prompt(`[Pasted Content ${Array.from(pending).length} chars]`)
  }
  input = input.replaceAll('\x1b[C', '')
  if (pending && input.includes('\r')) {
    appendFileSync(
      path,
      row('response_item', {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: pending }],
      }) +
        row('event_msg', { type: 'task_started', turn_id: id }) +
        row('response_item', {
          type: 'message',
          role: 'assistant',
          phase: 'final_answer',
          content: [{ type: 'output_text', text: 'Preserved original answer' }],
        }) +
        row('event_msg', { type: 'task_complete', turn_id: id })
    )
    const state = JSON.parse(readFileSync(journal, 'utf8'))
    writeFileSync(journal, JSON.stringify({ ...state, accepted: state.accepted + 1 }))
    pending = ''
    input = ''
    prompt()
  }
})
