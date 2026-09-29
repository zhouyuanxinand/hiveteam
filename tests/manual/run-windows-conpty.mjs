import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import {
  activeNodeEnvironment,
  captureChild,
  stopOwnedChild,
} from '../../scripts/pack-runtime-process.mjs'

if (process.platform !== 'win32') throw new Error('ConPTY acceptance requires Windows')
const result = resolve(process.argv[2] ?? '.validation/conpty-release.json')
mkdirSync(dirname(result), { recursive: true })
const acceptance = captureChild(
  process.execPath,
  ['--import', 'tsx', resolve('tests/manual/windows-conpty-acceptance.ts'), result],
  { env: activeNodeEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] }
)
let timeout
try {
  const completed = await Promise.race([
    acceptance.closed,
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('ConPTY acceptance timed out')), 150000)
    }),
  ])
  if (completed.error) throw completed.error
  assert.equal(completed.code, 0, 'ConPTY acceptance failed')
  const evidence = JSON.parse(readFileSync(result, 'utf8'))
  assert.equal(evidence.ok, true)
  assert.equal(evidence.pty_backend, 'ConPTY DLL')
  console.log(JSON.stringify(evidence))
} finally {
  clearTimeout(timeout)
  try {
    await stopOwnedChild(acceptance)
  } finally {
    const log = acceptance.output.stdout + acceptance.output.stderr
    writeFileSync(`${result}.log`, log)
    if (log) process.stderr.write(log)
  }
}
