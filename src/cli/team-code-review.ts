import { randomUUID } from 'node:crypto'

export const CODE_REVIEW_USAGE = [
  'team review context --dispatch <source-dispatch-id>',
  'team review file --dispatch <id> --version <version-json> --path <relative-path> [--side source|base]',
  'team review submit --dispatch <id> --version <version-json> --conclusion approve|changes_requested|comment [--request-id <uuid>] (<summary> | --stdin)',
  'Copy the complete version object returned by context. Do not refresh it automatically when submitting a review.',
].join('\n')

export const parseCodeReviewArgs = (args: string[]) => {
  const [action, ...rest] = args
  if (!['context', 'file', 'submit'].includes(action ?? '')) throw new Error(CODE_REVIEW_USAGE)
  const flags = new Map<string, string>()
  const positionals: string[] = []
  let useStdin = false
  const allowed = new Set([
    '--dispatch',
    ...(action !== 'context' ? ['--version'] : []),
    ...(action === 'file' ? ['--path', '--side'] : []),
    ...(action === 'submit' ? ['--conclusion', '--request-id'] : []),
  ])
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index] ?? ''
    if (arg === '--stdin' && action === 'submit' && !useStdin) {
      useStdin = true
      continue
    }
    if (arg.startsWith('--')) {
      const value = rest[++index]
      if (!allowed.has(arg) || flags.has(arg) || !value || value.startsWith('--'))
        throw new Error(CODE_REVIEW_USAGE)
      flags.set(arg, value)
    } else positionals.push(arg)
  }
  if (
    !flags.get('--dispatch') ||
    (action !== 'submit' && positionals.length) ||
    positionals.length > 1 ||
    (action === 'submit' && (useStdin ? positionals.length !== 0 : !positionals[0]?.trim()))
  )
    throw new Error(CODE_REVIEW_USAGE)
  const body: Record<string, unknown> = { dispatch_id: flags.get('--dispatch') }
  if (action !== 'context') {
    try {
      body.version = JSON.parse(flags.get('--version') ?? '')
    } catch {
      throw new Error(
        `--version must contain the JSON version object returned by context.\n${CODE_REVIEW_USAGE}`
      )
    }
    if (!body.version || typeof body.version !== 'object' || Array.isArray(body.version))
      throw new Error(CODE_REVIEW_USAGE)
  }
  if (action === 'file') {
    if (!flags.get('--path') || !['source', 'base'].includes(flags.get('--side') ?? 'source'))
      throw new Error(CODE_REVIEW_USAGE)
    body.path = flags.get('--path')
    body.side = flags.get('--side') ?? 'source'
  }
  if (action === 'submit') {
    if (!['approve', 'changes_requested', 'comment'].includes(flags.get('--conclusion') ?? ''))
      throw new Error(CODE_REVIEW_USAGE)
    body.conclusion = flags.get('--conclusion')
    body.request_id = flags.get('--request-id') ?? randomUUID()
    body.summary = positionals[0]
  }
  return { action, body, useStdin }
}
