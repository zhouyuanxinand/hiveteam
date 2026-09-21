import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

if (process.platform !== 'win32') throw new Error('ConPTY acceptance requires Windows')
const result = resolve(process.argv[2] ?? '.validation/conpty-release.json')
mkdirSync(dirname(result), { recursive: true })
const host = spawn(
  'pwsh.exe',
  [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    resolve('tests/manual/windows-conpty-host.ps1'),
    '-Node',
    process.execPath,
    '-Repository',
    process.cwd(),
    '-Result',
    result,
  ],
  { windowsHide: true, stdio: 'inherit' }
)
const timeout = setTimeout(() => {
  if (host.pid)
    spawn('taskkill.exe', ['/pid', String(host.pid), '/t', '/f'], {
      windowsHide: true,
      stdio: 'inherit',
    })
}, 150000)
try {
  const code = await new Promise((resolveCode, reject) => {
    host.once('error', reject)
    host.once('exit', resolveCode)
  })
  assert.equal(code, 0, 'ConPTY host failed')
  const evidence = JSON.parse(readFileSync(result, 'utf8'))
  assert.equal(evidence.ok, true)
  assert.equal(evidence.pty_backend, 'ConPTY')
  console.log(JSON.stringify(evidence))
  const log = readFileSync(`${result}.log`, 'utf8')
  if (log) process.stderr.write(log)
} finally {
  clearTimeout(timeout)
}
