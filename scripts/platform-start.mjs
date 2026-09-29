import { readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

import { runPlatformConsole } from './platform-console.mjs'

const args = process.argv.slice(2)
if (args.length !== 2 || args[0] !== '--config' || !isAbsolute(args[1])) {
  throw new Error('Usage: platform-start.mjs --config <absolute configuration path>')
}
const config = JSON.parse(readFileSync(args[1], 'utf8'))
const allowed = new Set([
  'project_root',
  'node_executable',
  'data_dir',
  'runtime_port',
  'web_port',
  'launch_mode',
  'runtime_entry',
])
if (
  !config ||
  typeof config !== 'object' ||
  Array.isArray(config) ||
  Object.keys(config).some((key) => !allowed.has(key))
)
  throw new Error('Invalid startup configuration')
for (const key of ['project_root', 'node_executable', 'data_dir']) {
  if (typeof config[key] !== 'string' || !isAbsolute(config[key]))
    throw new Error(`Invalid startup ${key}`)
}
for (const key of ['runtime_port', ...(config.launch_mode === 'development' ? ['web_port'] : [])]) {
  if (!Number.isInteger(config[key]) || config[key] < 1 || config[key] > 65535)
    throw new Error(`Invalid startup ${key}`)
}
if (!['runtime', 'development'].includes(config.launch_mode))
  throw new Error('Invalid startup launch_mode')
if (config.runtime_entry !== undefined && !['source', 'built'].includes(config.runtime_entry))
  throw new Error('Invalid startup runtime_entry')
await runPlatformConsole({
  projectRoot: config.project_root,
  nodeExecutable: config.node_executable,
  dataDir: config.data_dir,
  runtimePort: config.runtime_port,
  webPort: config.web_port,
  launchMode: config.launch_mode,
  ...(config.runtime_entry === undefined
    ? {}
    : {
        runtimeEntry: resolve(
          config.project_root,
          config.runtime_entry === 'source' ? 'src/cli/hive.ts' : 'dist/src/cli/hive.js'
        ),
      }),
})
