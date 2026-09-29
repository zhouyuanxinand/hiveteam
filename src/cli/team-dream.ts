export const TEAM_DREAM_USAGE = [
  'team dream input --dream <id> [--section generation|operations|sources] [--offset <n>] [--limit <1-10>]',
  'team dream result --dream <id> --attempt <id> --input-hash <sha256> --stdin',
  'team dream fail --dream <id> --attempt <id> --stdin',
].join('\n')

export const parseDreamArgs = (args: string[]) => {
  const [action, ...rest] = args
  if (action !== 'input' && action !== 'result' && action !== 'fail')
    throw new Error(TEAM_DREAM_USAGE)
  const flags = new Map<string, string>()
  let useStdin = false
  const allowed = new Set([
    '--dream',
    ...(action === 'input'
      ? ['--section', '--offset', '--limit']
      : ['--attempt', ...(action === 'result' ? ['--input-hash'] : [])]),
  ])
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index] ?? ''
    if (flag === '--stdin' && action !== 'input' && !useStdin) {
      useStdin = true
      continue
    }
    const value = rest[++index]
    if (!allowed.has(flag) || flags.has(flag) || !value || value.startsWith('--'))
      throw new Error(TEAM_DREAM_USAGE)
    flags.set(flag, value)
  }
  if (!flags.get('--dream') || (action !== 'input' && (!useStdin || !flags.get('--attempt'))))
    throw new Error(TEAM_DREAM_USAGE)
  const body: Record<string, unknown> = { dream_id: flags.get('--dream') }
  if (action === 'input') {
    const section = flags.get('--section') ?? 'generation'
    const offset = flags.get('--offset') ?? '0'
    const limit = flags.get('--limit') ?? '5'
    if (
      !['generation', 'operations', 'sources'].includes(section) ||
      !/^\d+$/.test(offset) ||
      !Number.isSafeInteger(Number(offset)) ||
      !/^\d+$/.test(limit) ||
      Number(limit) < 1 ||
      Number(limit) > 10
    )
      throw new Error(TEAM_DREAM_USAGE)
    Object.assign(body, { section, offset: Number(offset), limit: Number(limit) })
  } else {
    body.attempt_id = flags.get('--attempt')
    if (action === 'result') {
      const hash = flags.get('--input-hash') ?? ''
      if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error(TEAM_DREAM_USAGE)
      body.input_hash = hash
    }
  }
  return { action, body, useStdin }
}
