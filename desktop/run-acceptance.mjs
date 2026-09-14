import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopRoot = dirname(fileURLToPath(import.meta.url))
const electronCli = resolve(desktopRoot, 'node_modules', 'electron', 'cli.js')
const resultPath = join(tmpdir(), `hiveteam-desktop-acceptance-${randomUUID()}.json`)
const child = spawnSync(
  process.execPath,
  [electronCli, resolve(desktopRoot, 'acceptance.mjs'), ...process.argv.slice(2)],
  {
    cwd: resolve(desktopRoot, '..'),
    env: { ...process.env, HIVE_DESKTOP_ACCEPTANCE_RESULT_PATH: resultPath },
    stdio: 'inherit',
    timeout: 90_000,
  }
)

let result = null
try {
  if (existsSync(resultPath)) result = JSON.parse(readFileSync(resultPath, 'utf8'))
} finally {
  rmSync(resultPath, { force: true })
}

if (typeof result?.cleanup_path === 'string') {
  const tempRoot = resolve(tmpdir())
  const cleanupPath = resolve(result.cleanup_path)
  const withinTemp = cleanupPath.toLowerCase().startsWith(`${tempRoot.toLowerCase()}${sep}`)
  if (withinTemp && basename(cleanupPath).startsWith('hiveteam-desktop-acceptance-')) {
    rmSync(cleanupPath, { force: true, maxRetries: 20, recursive: true, retryDelay: 100 })
  }
}

if (child.error) {
  console.error('[desktop acceptance] Electron driver failed:', child.error)
  process.exitCode = 1
} else if (!result?.ok) {
  console.error(
    `[desktop acceptance] assertion failed${result?.error ? `: ${result.error}` : ' without a result'}`
  )
  process.exitCode = 1
}
