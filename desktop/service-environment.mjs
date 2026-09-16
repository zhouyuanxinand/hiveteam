import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const NPM_PREFIX_OVERRIDE = 'npm_config_prefix'

export const createDesktopServiceEnvironment = (baseEnvironment, overrides = {}) => {
  const environment = {
    ...baseEnvironment,
    ...overrides,
  }

  // Pin the invocation directory before the service changes cwd to the install root.
  environment.HIVE_DATA_DIR = resolve(
    environment.HIVE_DATA_DIR || join(homedir(), '.config', 'hive')
  )

  for (const key of Object.keys(environment)) {
    if (key.toLowerCase() === NPM_PREFIX_OVERRIDE) delete environment[key]
  }

  return environment
}
