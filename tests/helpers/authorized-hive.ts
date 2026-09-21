import { runHiveCommand } from '../../src/cli/hive.js'
import { installSyntheticAgentAuthorization } from './authorized-runtime.js'

/** Legacy CLI fixtures authorize their synthetic executables before starting an agent. */
export const runAuthorizedTestHiveCommand = async (...args: Parameters<typeof runHiveCommand>) => {
  const runtime = await runHiveCommand(...args)
  installSyntheticAgentAuthorization(runtime.store)
  return runtime
}
