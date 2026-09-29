import { randomUUID } from 'node:crypto'

export const TEAM_REVIEW_REQUEST_USAGE =
  'team review --dispatch <source-dispatch-id> [--cli <allowed-preset>] [--request-id <uuid>] "<focus>"'
export const parseTeamReviewRequestArgs = (args: string[]) => {
  const flags = new Map<string, string>(),
    positionals: string[] = []
  for (let i = 0; i < args.length; i++) {
    const value = args[i] ?? ''
    if (value.startsWith('--')) {
      const next = args[++i]
      if (
        !['--dispatch', '--cli', '--request-id'].includes(value) ||
        flags.has(value) ||
        !next?.trim() ||
        next.startsWith('--')
      )
        throw new Error(TEAM_REVIEW_REQUEST_USAGE)
      flags.set(value, next)
    } else positionals.push(value)
  }
  if (!flags.get('--dispatch') || positionals.length !== 1 || !positionals[0]?.trim())
    throw new Error(TEAM_REVIEW_REQUEST_USAGE)
  return {
    action: 'request',
    useStdin: false,
    body: {
      request_id: flags.get('--request-id') ?? randomUUID(),
      dispatch_id: flags.get('--dispatch'),
      focus: positionals[0],
      ...(flags.has('--cli') ? { command_preset_id: flags.get('--cli') } : {}),
    } as Record<string, unknown>,
  }
}
