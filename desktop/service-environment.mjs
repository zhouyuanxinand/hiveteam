const NPM_PREFIX_OVERRIDE = 'npm_config_prefix'

export const createDesktopServiceEnvironment = (baseEnvironment, overrides = {}) => {
  const environment = {
    ...baseEnvironment,
    ...overrides,
  }

  for (const key of Object.keys(environment)) {
    if (key.toLowerCase() === NPM_PREFIX_OVERRIDE) delete environment[key]
  }

  return environment
}
