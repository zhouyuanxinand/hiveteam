import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runPlatformConsole } from './platform-console.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const development =
  existsSync(resolve(projectRoot, 'src/cli/hive.ts')) &&
  existsSync(resolve(projectRoot, 'node_modules/vite/bin/vite.js'))
const readPort = (name, fallback) => {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`${name} must be an integer between 1 and 65535`)
  return port
}
await runPlatformConsole({
  projectRoot,
  dataDir: resolve(process.env.HIVE_DATA_DIR || join(homedir(), '.config', 'hive')),
  runtimePort: readPort('HIVE_RUNTIME_PORT', development ? 4010 : 9483),
  webPort: readPort('HIVE_WEB_PORT', 5180),
  launchMode: development ? 'development' : 'runtime',
})
