import type { WorkerRole } from '../shared/types.js'
export const SPAWN_USAGE =
  'Usage: team spawn --name <name> --role coder|reviewer|tester|custom --preset <id> [--model <id>] [--description <text>] [--isolated] [--no-start]'
export const DISMISS_USAGE = 'Usage: team dismiss --worker <id>'
export const parseSpawnArgs = (args: string[]) => {
  const flags = new Map<string, string>()
  const switches = new Set<string>()
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]
    if (flag === '--isolated' || flag === '--no-start') {
      if (switches.has(flag)) throw new Error(SPAWN_USAGE)
      switches.add(flag)
    } else {
      const value = args[++i]
      if (
        !flag ||
        !['--name', '--role', '--preset', '--model', '--description'].includes(flag) ||
        flags.has(flag) ||
        !value?.trim() ||
        value.startsWith('--')
      )
        throw new Error(SPAWN_USAGE)
      flags.set(flag, value)
    }
  }
  const name = flags.get('--name'),
    role = flags.get('--role'),
    preset = flags.get('--preset')
  if (!name || !role || !preset || !['coder', 'reviewer', 'tester', 'custom'].includes(role))
    throw new Error(SPAWN_USAGE)
  return {
    name,
    role: role as WorkerRole,
    command_preset_id: preset,
    ...(flags.has('--model') ? { model: flags.get('--model') } : {}),
    ...(flags.has('--description') ? { description: flags.get('--description') } : {}),
    isolated: switches.has('--isolated'),
    autostart: !switches.has('--no-start'),
  }
}
export const parseDismissArgs = (args: string[]) => {
  if (args.length !== 2 || args[0] !== '--worker' || !args[1]?.trim() || args[1].startsWith('--'))
    throw new Error(DISMISS_USAGE)
  return { worker_id: args[1] }
}
