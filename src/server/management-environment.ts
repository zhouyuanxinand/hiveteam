/** Management capabilities must never become model-generated command credentials. */
const MANAGEMENT_VARIABLES = new Set([
  'HIVE_UI_TOKEN',
  'HIVE_UI_BOOTSTRAP',
  'HIVE_BOOTSTRAP_TOKEN',
  'HIVE_SUPERVISOR_TOKEN',
  'HIVE_REMOTE_SECRET',
  'HIVE_REMOTE_DAEMON_TOKEN',
  'HIVE_DESKTOP_BRIDGE_TOKEN',
  'NODE_CHANNEL_FD',
  'NODE_CHANNEL_SERIALIZATION_MODE',
])

export const withoutManagementCredentials = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(env).filter(
      ([key, value]) => value !== undefined && !MANAGEMENT_VARIABLES.has(key.toUpperCase())
    )
  )
