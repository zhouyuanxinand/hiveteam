import { appendFileSync, existsSync, writeFileSync } from 'node:fs'

// An interactive application, not a PTY mock: Enter can arrive before the
// application finishes processing its paste. Accepted user input is journaled.
const [journal, sessionId, delay = '1600', ignoredEnters = '1', display = 'collapsed'] =
  process.argv.slice(2)
const record = (payload) => appendFileSync(journal, `${JSON.stringify(payload)}\n`)
if (display !== 'delayed-session') {
  writeFileSync(journal, '')
  record({ type: 'session_meta', payload: { id: sessionId, cwd: process.cwd() } })
  record({
    type: 'response_item',
    payload: {
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: `Hive session binding: workspace_id=${process.env.HIVE_PROJECT_ID}; agent_id=${process.env.HIVE_AGENT_ID}`,
        },
      ],
    },
  })
}
process.stdin.setRawMode(true)
process.stdin.setEncoding('utf8')
let input = ''
let pending = ''
let ready = false
let ignored = Number(ignoredEnters)
let pastes = 0
let isReport = false
const prompt = (text = 'Ask Codex to do anything') => process.stdout.write(`\r\n› ${text}\r\n`)
const mixedPaste = (text) => {
  const points = Array.from(text)
  const head = points.slice(0, 24).join('')
  const tail = points.slice(-24).join('')
  return `${head}[Pasted Content ${points.length - 48} chars]\r\n  ${tail}`
}
prompt()
process.stdin.on('data', (chunk) => {
  if (chunk.includes('\x03')) process.exit(0)
  input += chunk
  const start = input.indexOf('\x1b[200~')
  const end = input.indexOf('\x1b[201~')
  if (start >= 0 && end > start) {
    pending = input.slice(start + 6, end)
    isReport = pending.includes('[Hive report receipt:')
    input = input.slice(end + 6)
    ready = false
    if (isReport) pastes += 1
    process.stdout.write(`\r\nPASTES=${pastes}\r\n`)
    setTimeout(
      () => {
        ready = true
        const receipt = pending.match(/\[Hive report receipt: [\da-f-]+\]/)?.[0]
        prompt(
          display === 'mixed' && receipt
            ? mixedPaste(pending)
            : display === 'expanded' && receipt
              ? `${pending.slice(0, 50)}\r\n  ${receipt}\r\n`
              : `[Pasted Content ${Array.from(pending).length} chars]`
        )
        if (isReport && display === 'blocked')
          process.stdout.write('\r\nPress enter to confirm or esc to cancel\r\n')
      },
      isReport ? Number(delay) : 0
    )
  }
  if (input.includes('\r')) {
    input = ''
    if (!ready || (isReport && ignored-- > 0)) {
      process.stdout.write('\r\nENTER_IGNORED\r\n')
      return
    }
    if (!existsSync(journal))
      record({ type: 'session_meta', payload: { id: sessionId, cwd: process.cwd() } })
    record({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: display === 'corrupt-receipt' ? pending.replace('UNCHANGED', 'CHANGED') : pending,
          },
        ],
      },
    })
    process.stdout.write('\r\nAPPLICATION_ACCEPTED\r\n')
    pending = ''
    ready = false
    prompt()
  }
})
