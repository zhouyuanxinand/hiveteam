const VALUE_OPTIONS = new Set([
  '-c',
  '--config',
  '--enable',
  '--disable',
  '--remote',
  '--remote-auth-token-env',
  '-i',
  '--image',
  '-m',
  '--model',
  '--local-provider',
  '-p',
  '--profile',
  '-s',
  '--sandbox',
  '-C',
  '--cd',
  '--add-dir',
  '-a',
  '--ask-for-approval',
])
const FLAG_OPTIONS = new Set([
  '--strict-config',
  '--oss',
  '--approve-for-me',
  '--full-auto',
  '--dangerously-bypass-approvals-and-sandbox',
  '--dangerously-bypass-hook-trust',
  '--worktree',
  '--search',
  '--no-alt-screen',
  '--no-daemon',
  '-h',
  '--help',
  '-V',
  '--version',
])

/** Find the native subcommand without mistaking a global option's value for it. */
export const findCodexResumeCommandIndex = (args: readonly string[]) => {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (!arg || arg === '--') return -1
    if (arg === 'resume') return index
    if (FLAG_OPTIONS.has(arg)) continue
    const key = arg.split('=', 1)[0] ?? ''
    if (VALUE_OPTIONS.has(key)) {
      if (key === arg) index += 1
      continue
    }
    if (arg.length > 2 && VALUE_OPTIONS.has(arg.slice(0, 2))) continue
    // A prompt or another subcommand ends the global-option prefix. Unknown
    // options are not guessed because their values could themselves be resume.
    return -1
  }
  return -1
}
