import { renameSync, writeFileSync } from 'node:fs'

const [journal, mode = 'collapsed'] = process.argv.slice(2)
const state = {
  accepted: [],
  pastes: 0,
  enters: 0,
  draft: '',
  hooksChoice: '',
  flushed: false,
  ready: false,
  replies: [],
  prematurePastes: 0,
}
const save = () => {
  writeFileSync(`${journal}.tmp`, JSON.stringify(state))
  renameSync(`${journal}.tmp`, journal)
}
const pasteLabel = (text) =>
  `[Pasted Content ${Array.from(text).length.toLocaleString('en-US')} chars]`
let composerVisible = false
const prompt = (text = 'Ask Codex to do anything') => {
  composerVisible = true
  if (mode.startsWith('cursor-addressed')) {
    process.stdout.write(`\x1b[2J\x1b[1;1HOpenAI Codex\x1b[4;1H› ${text}\x1b[6;1H? for shortcuts`)
  } else if (mode === 'resized') {
    process.stdout.write(
      `\x1b[?1049h\x1b[2J\x1b[H› ${text}\r\n${'\r\n'.repeat(Math.max(0, process.stdout.rows - 4))}`
    )
  } else process.stdout.write(`\x1b[2J\x1b[H› ${text}\r\n`)
}
process.stdin.setRawMode(true)
process.stdin.setEncoding('utf8')
let input = ''
let pending = ''
let ready = false
let ignored = false
let onboarding = mode === 'trust' ? 'directory' : 'done'
process.stdout.on('resize', () => {
  if (mode === 'resized' && ready) prompt(pasteLabel(pending))
})
save()
if (onboarding === 'directory')
  process.stdout.write(
    'Do you trust the contents of this directory?\r\nPress enter to continue\r\n'
  )
else
  prompt(
    mode === 'existing-draft' || mode === 'cursor-addressed-draft'
      ? 'Unsubmitted user draft'
      : undefined
  )
if (mode === 'delayed-composer') {
  // Native Codex can briefly draw a prompt, switch to onboarding/loading,
  // then paint its actual composer after Hive has seen that first prompt.
  setTimeout(() => {
    composerVisible = false
    process.stdout.write('\x1b[2J\x1b[HLoading Codex...\r\n')
  }, 500)
  setTimeout(() => prompt(), 2200)
}
if (mode === 'late-trust') {
  setTimeout(() => {
    composerVisible = false
    process.stdout.write('\x1b[2J\x1b[HLoading Codex...\r\n')
  }, 500)
  setTimeout(() => {
    onboarding = 'directory'
    process.stdout.write(
      '\x1b[2J\x1b[HDo you trust the contents of this directory?\r\n› 1. Yes, continue\r\nPress enter to continue\r\n'
    )
  }, 1500)
}
process.stdin.on('data', (chunk) => {
  if (chunk.includes('\x03')) process.exit(0)
  if (onboarding === 'directory' && chunk.includes('\r')) {
    onboarding = 'hooks'
    process.stdout.write(
      "\x1b[2J\x1b[HHooks need review\r\n1. Review hooks\r\n2. Trust all\r\n3. Continue without trusting (hooks won't run)\r\n"
    )
    return
  }
  if (onboarding === 'hooks') {
    input += chunk
    if (!input.includes('\r')) return
    state.hooksChoice = input === '\x1b[B\x1b[B\r' ? 'continue-without-hooks' : 'unexpected'
    input = ''
    onboarding = 'done'
    save()
    prompt()
    return
  }
  input += chunk
  const start = input.indexOf('\x1b[200~')
  const end = input.indexOf('\x1b[201~')
  if (start >= 0 && end > start) {
    if (!composerVisible) state.prematurePastes += 1
    pending = input.slice(start + 6, end)
    input = input.slice(end + 6)
    state.pastes += 1
    save()
    const completePaste = pending
    // A real interactive process whose composer accepts a paste asynchronously.
    // Its first Enter can still be consumed by paste-burst handling.
    setTimeout(() => {
      ready = true
      if (mode === 'partial-expanded' || mode === 'partial-count')
        pending = completePaste.slice(0, 200)
      if (mode === 'near-complete')
        pending = Array.from(completePaste)
          .slice(0, -(completePaste.split('\n').length - 1))
          .join('')
      prompt(
        mode === 'expanded' || mode === 'partial-expanded'
          ? pending.replaceAll('\n', '\r\n')
          : pasteLabel(pending)
      )
      if (mode === 'blocked')
        process.stdout.write('\r\nPress enter to confirm or esc to cancel\r\n')
      state.ready = true
      save()
    }, 1800)
    if (['partial-expanded', 'partial-count', 'near-complete'].includes(mode))
      setTimeout(() => {
        pending = completePaste
        prompt(pasteLabel(pending))
      }, 4500)
  }
  if (input.includes('USER_DRAFT')) {
    state.draft += 'USER_DRAFT'
    input = input.replace('USER_DRAFT', '')
    save()
  }
  if (input.includes('\x1b[?2026;2$y')) {
    state.replies.push('\x1b[?2026;2$y')
    input = input.replace('\x1b[?2026;2$y', '')
    save()
  }
  if (input.includes('\x1b[C')) {
    state.flushed = true
    input = input.replace('\x1b[C', '')
    save()
  }
  if (input.includes('\r')) {
    input = ''
    state.enters += 1
    if (ready && ignored && pending && (mode !== 'burst' || state.flushed)) {
      state.accepted.push(pending + state.draft)
      pending = ''
      ready = false
      prompt()
    } else if (ready) ignored = true
    save()
  }
})
