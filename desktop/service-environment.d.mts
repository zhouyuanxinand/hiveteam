export const createDesktopServiceEnvironment: (
  baseEnvironment: NodeJS.ProcessEnv,
  overrides?: NodeJS.ProcessEnv
) => NodeJS.ProcessEnv & { HIVE_DATA_DIR: string }
