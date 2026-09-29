import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const runInitialDispatchCli = (root) => {
  const args = process.argv.slice(2)
  if (args.includes('--help')) {
    console.log(
      'Codex CLI\nUsage: codex [OPTIONS] [PROMPT]\n  --no-daemon  Run without a shared daemon'
    )
    return
  }
  if (args.includes('--version')) {
    console.log('codex-cli 0.159.0')
    return
  }
  let resumedId = null
  const positional = []
  const values = new Set([
    '-c',
    '--config',
    '-m',
    '--model',
    '-s',
    '--sandbox',
    '-a',
    '--ask-for-approval',
    '-C',
    '--cd',
  ])
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') {
      positional.push(...args.slice(i + 1))
      break
    }
    if (arg === 'resume') resumedId = args[++i]
    else if (values.has(arg)) i++
    else if (!arg.startsWith('-')) positional.push(arg)
  }
  if (positional.length > 1) throw new Error('Expected one native initial message argument')
  const prompt = positional[0] ?? null
  const agentId = process.env.HIVE_AGENT_ID
  const modeFile = join(root, `${agentId}.mode`)
  const mode = existsSync(modeFile) ? readFileSync(modeFile, 'utf8') : 'accept'
  const sessionId = resumedId ?? randomUUID()
  const directory = join(process.env.CODEX_HOME, 'sessions')
  mkdirSync(directory, { recursive: true })
  const historyPath = join(directory, `rollout-${sessionId}.jsonl`)
  const stdinPath = join(root, `stdin-${randomUUID()}.txt`)
  writeFileSync(stdinPath, '')
  appendFileSync(
    join(root, 'launches.jsonl'),
    `${JSON.stringify({ agentId, args, prompt, sessionId, resumedId, historyPath, stdinPath })}\n`
  )
  if (prompt !== null && mode === 'exit-before-receipt') {
    process.stdout.write('INITIAL_DISPATCH_ABORTED\r\n')
    return
  }
  if (resumedId && !existsSync(historyPath)) throw new Error('Native session not found')
  if (prompt !== null) {
    if (!resumedId)
      writeFileSync(
        historyPath,
        `${JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd: process.cwd() } })}\n`
      )
    const received = mode === 'drop-newlines' ? prompt.replaceAll('\n', '') : prompt
    appendFileSync(
      historyPath,
      `${JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: received }] } })}\n`
    )
  }
  process.stdin.setRawMode(true)
  process.stdin.on('data', (data) => appendFileSync(stdinPath, data))
  process.stdout.write('INITIAL_DISPATCH_READY\r\n› Ask Codex to do anything\r\n')
  process.stdin.resume()
}
