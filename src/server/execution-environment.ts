const PLATFORM_ENVIRONMENT = new Set([
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMDATA',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TERM',
  'COLORTERM',
  'TERM_PROGRAM',
  'FORCE_COLOR',
  'NO_COLOR',
])

/** Unrelated API keys, cloud credentials, SSH agents and runtime secrets never inherit. */
export const createExecutionEnvironment = (
  input: NodeJS.ProcessEnv = {},
  parent: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(parent)) {
    if (value !== undefined && PLATFORM_ENVIRONMENT.has(key.toUpperCase())) environment[key] = value
  }
  for (const [key, value] of Object.entries(input)) {
    if (process.platform === 'win32') {
      for (const inherited of Object.keys(environment))
        if (inherited.toUpperCase() === key.toUpperCase()) delete environment[inherited]
    }
    if (value === undefined) delete environment[key]
    else environment[key] = value
  }
  return environment
}
