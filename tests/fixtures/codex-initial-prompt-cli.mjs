import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const runInitialPromptCli = (evidenceRoot) => {
  const args = process.argv.slice(2)
  if (args.includes('--help')) {
    console.log(
      'Codex CLI\nUsage: codex [OPTIONS] [PROMPT]\nOptions:\n  --no-daemon  Run without the shared daemon'
    )
    return
  }
  if (args.includes('--version')) {
    console.log('codex-cli 0.159.0')
    return
  }
  const valueOptions = new Set([
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
  const positional = []
  let resumedId = null
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--') {
      positional.push(...args.slice(index + 1))
      break
    }
    if (arg === 'resume') {
      resumedId = args[++index]
      continue
    }
    if (valueOptions.has(arg)) {
      index += 1
      continue
    }
    if (arg.startsWith('-')) continue
    positional.push(arg)
  }
  if (positional.length > 1) throw new Error('Expected a single initial prompt argument')
  const prompt = positional[0] ?? null
  if (existsSync(join(evidenceRoot, 'exit-before-session'))) {
    process.stdout.write('INITIAL_PROMPT_ABORTED_BEFORE_SESSION\r\n')
    return
  }
  const sessionId = resumedId ?? randomUUID()
  const sessions = join(process.env.CODEX_HOME, 'sessions')
  mkdirSync(sessions, { recursive: true })
  const historyPath = join(sessions, `rollout-${sessionId}.jsonl`)
  if (resumedId) {
    if (!existsSync(historyPath)) throw new Error('The resumed native session does not exist')
    readFileSync(historyPath, 'utf8')
  } else
    writeFileSync(
      historyPath,
      `${JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd: process.cwd() } })}\n`
    )
  if (prompt !== null)
    appendFileSync(
      historyPath,
      `${JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] } })}\n`
    )
  const stdinPath = join(evidenceRoot, `stdin-${randomUUID()}.txt`)
  writeFileSync(stdinPath, '')
  appendFileSync(
    join(evidenceRoot, 'launches.jsonl'),
    `${JSON.stringify({ args, prompt, sessionId, resumedId, historyPath, stdinPath })}\n`
  )
  process.stdin.setRawMode(true)
  process.stdin.on('data', (chunk) => appendFileSync(stdinPath, chunk))
  process.stdout.write('INITIAL_PROMPT_READY\r\n› Ask Codex to do anything\r\n')
  process.stdin.resume()
}
