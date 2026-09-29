import { DISPATCH_MESSAGE_KINDS, type DispatchMessageKind } from '../shared/dispatch-messages.js'

export const MESSAGE_USAGE =
  'Usage: team message --dispatch <id> --kind note|question|answer|progress [--reply-to <message-id>] (<body> | --stdin)'
export const MESSAGES_USAGE =
  'Usage: team messages --dispatch <id> [--after <sequence>] [--limit <1-100>]'

export const parseMessageSequence = (value: string | undefined, flag: string) => {
  if (!value || !/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new Error(`${flag} requires a non-negative integer`)
  return Number(value)
}

const parse = (args: string[], reading: boolean) => {
  const usage = reading ? MESSAGES_USAGE : MESSAGE_USAGE
  const flags = new Map<string, string>()
  const positionals: string[] = []
  let stdin = false
  let positionalOnly = false
  const allowed = reading
    ? ['--dispatch', '--after', '--limit']
    : ['--dispatch', '--kind', '--reply-to']
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === undefined) continue
    if (!positionalOnly && arg === '--') {
      positionalOnly = true
      continue
    }
    if (!positionalOnly && arg === '--stdin' && !reading && !stdin) {
      stdin = true
      continue
    }
    if (!positionalOnly && arg.startsWith('--')) {
      const value = args[++index]
      if (!allowed.includes(arg) || flags.has(arg) || !value || value.startsWith('--'))
        throw new Error(usage)
      flags.set(arg, value)
    } else positionals.push(arg)
  }
  const dispatchId = flags.get('--dispatch')
  if (!dispatchId) throw new Error(usage)
  return { dispatchId, flags, positionals, stdin, usage }
}

export const parseMessageArgs = (args: string[]) => {
  const { dispatchId, flags, positionals, stdin, usage } = parse(args, false)
  const kind = flags.get('--kind')
  if (
    !kind ||
    !(DISPATCH_MESSAGE_KINDS as readonly string[]).includes(kind) ||
    positionals.length !== (stdin ? 0 : 1) ||
    (!stdin && !positionals[0]?.trim())
  )
    throw new Error(usage)
  const replyTo = flags.get('--reply-to')
  if (kind === 'answer' && !replyTo) throw new Error(`An answer requires --reply-to\n${usage}`)
  return {
    dispatchId,
    kind: kind as DispatchMessageKind,
    replyTo,
    useStdin: stdin,
    body: positionals[0] ?? null,
  }
}

export const parseMessagesArgs = (args: string[]) => {
  const { dispatchId, flags, positionals, usage } = parse(args, true)
  if (positionals.length) throw new Error(usage)
  const after = parseMessageSequence(flags.get('--after') ?? '0', '--after')
  const limit = parseMessageSequence(flags.get('--limit') ?? '50', '--limit')
  if (limit < 1 || limit > 100) throw new Error(usage)
  return { dispatchId, after, limit }
}
