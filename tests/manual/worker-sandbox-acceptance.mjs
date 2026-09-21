import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, open, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
// File capture avoids Node's socket-backed stdio interacting with denied sockets.
const executeSandbox = async (command, args, options, outputPrefix) => {
  const stdoutFile = `${outputPrefix}.stdout`
  const stderrFile = `${outputPrefix}.stderr`
  const stdout = await open(stdoutFile, 'w')
  const stderr = await open(stderrFile, 'w')
  try {
    const code = await new Promise((resolve, reject) => {
      const child = spawn(command, args, { ...options, stdio: ['ignore', stdout.fd, stderr.fd] })
      child.once('error', reject)
      child.once('close', resolve)
    })
    const output = {
      stdout: await readFile(stdoutFile, 'utf8'),
      stderr: await readFile(stderrFile, 'utf8'),
    }
    assert.equal(code, 0, `Sandbox failed: ${output.stderr}`)
    return output
  } finally {
    await stdout.close()
    await stderr.close()
  }
}
const options = new Map()
for (let index = 2; index < process.argv.length; index += 2) {
  options.set(process.argv[index], process.argv[index + 1])
}
const codexArgument = options.get('--codex')
const reportPath = options.get('--report')
assert.equal(process.platform, 'linux', 'Run this acceptance inside native Linux or WSL2 Linux.')
assert.ok(
  codexArgument && isAbsolute(codexArgument),
  '--codex must name an absolute native binary.'
)
assert.ok(reportPath && isAbsolute(reportPath), '--report must name an absolute output file.')
const executable = await realpath(codexArgument)
const fixture = await mkdtemp('/var/tmp/hive-execution-acceptance-')
const locations = Object.fromEntries(
  ['home', 'source', 'scratch', 'outside', 'mailbox'].map((key) => [key, join(fixture, key)])
)
for (const directory of Object.values(locations)) await mkdir(directory)
await writeFile(join(locations.source, 'source.txt'), 'synthetic source\n')
await writeFile(join(locations.outside, 'secret.txt'), 'synthetic secret sentinel\n')
await writeFile(join(locations.home, 'auth.json'), '{"synthetic_secret":"not-a-real-credential"}\n')
const environment = {
  PATH: '/usr/bin:/bin',
  HOME: locations.home,
  CODEX_HOME: locations.home,
  LANG: 'C.UTF-8',
  TMPDIR: locations.scratch,
}
const version = (
  await execute(executable, ['--version'], { env: environment, timeout: 10_000 })
).stdout.trim()
assert.equal(version, 'codex-cli 0.155.1', 'This evidence is pinned to the verified CLI version.')
const listener = createServer((socket) => socket.destroy())
await new Promise((resolve, reject) => {
  listener.once('error', reject)
  listener.listen(0, '127.0.0.1', resolve)
})
const address = listener.address()
assert.ok(address && typeof address === 'object')
const evidence = {
  cli_version: version,
  platform: process.platform,
  recorded_at: new Date().toISOString(),
  fixture_path: fixture,
  scope: 'Real native sandbox commands; does not certify model tools, authentication, or resume.',
  results: [],
}

try {
  const { symlink } = await import('node:fs/promises')
  await symlink(locations.outside, join(locations.source, 'escape'))
  const probeSource = `
    const fs = require('node:fs')
    const net = require('node:net')
    const input = JSON.parse(process.argv[2])
    const results = {}
    const attempt = (key, action) => {
      try { action(); results[key] = 'allowed' }
      catch (error) { results[key] = error.code || error.name }
    }
    attempt('source_read', () => fs.readFileSync(input.source + '/source.txt'))
    attempt('source_write', () => fs.writeFileSync(input.source + '/created.txt', 'synthetic edit'))
    attempt('scratch_write', () => fs.writeFileSync(input.scratch + '/report.txt', 'synthetic report'))
    attempt('outside_read', () => fs.readFileSync(input.outside + '/secret.txt'))
    attempt('outside_write', () => fs.writeFileSync(input.outside + '/escape.txt', 'escape'))
    attempt('credential_read', () => fs.readFileSync(input.home + '/auth.json'))
    attempt('symlink_read', () => fs.readFileSync(input.source + '/escape/secret.txt'))
    attempt('symlink_write', () => fs.writeFileSync(input.source + '/escape/escape.txt', 'escape'))
    fs.writeFileSync(input.mailbox + '/request.pending', JSON.stringify({ command: 'report', body: 'synthetic report' }))
    fs.renameSync(input.mailbox + '/request.pending', input.mailbox + '/request.json')
    const socket = net.createConnection({ host: '127.0.0.1', port: input.port })
    socket.setTimeout(1000)
    socket.once('connect', () => { results.direct_tcp = 'connected'; socket.destroy() })
    socket.once('error', (error) => { results.direct_tcp = error.code || error.name })
    socket.once('timeout', () => { results.direct_tcp = 'timeout'; socket.destroy() })
    socket.once('close', async () => {
      const deadline = Date.now() + 3000
      while (!fs.existsSync(input.mailbox + '/response.json') && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      results.mailbox_report = fs.existsSync(input.mailbox + '/response.json')
        ? JSON.parse(fs.readFileSync(input.mailbox + '/response.json', 'utf8')).ok : false
      console.log(JSON.stringify(results))
    })
  `
  await writeFile(join(locations.source, 'probe.cjs'), probeSource)
  for (const role of ['coder', 'reviewer']) {
    const { unlink } = await import('node:fs/promises')
    for (const name of ['request.json', 'response.json']) {
      await unlink(join(locations.mailbox, name)).catch((error) => {
        if (error.code !== 'ENOENT') throw error
      })
    }
    const filesystem = [
      '":root" = "deny"',
      '":minimal" = "read"',
      `${JSON.stringify(locations.source)} = "${role === 'coder' ? 'write' : 'read'}"`,
      `${JSON.stringify(locations.scratch)} = "write"`,
      `${JSON.stringify(locations.mailbox)} = "write"`,
      `${JSON.stringify(dirname(executable))} = "read"`,
      `${JSON.stringify(dirname(process.execPath))} = "read"`,
    ].join('\n')
    await writeFile(
      join(locations.home, 'config.toml'),
      `default_permissions = "hive-probe"\napproval_policy = "never"\n[permissions.hive-probe.filesystem]\n${filesystem}\n[permissions.hive-probe.network]\nenabled = false\n`
    )
    let handlingRequest = false
    let brokerError
    const broker = setInterval(async () => {
      if (handlingRequest) return
      handlingRequest = true
      try {
        const request = JSON.parse(await readFile(join(locations.mailbox, 'request.json'), 'utf8'))
        await writeFile(
          join(locations.mailbox, 'response.pending'),
          JSON.stringify({
            ok: request.command === 'report' && request.body === 'synthetic report',
          })
        )
        await rename(
          join(locations.mailbox, 'response.pending'),
          join(locations.mailbox, 'response.json')
        )
      } catch (error) {
        if (error.code !== 'ENOENT') brokerError = error
      } finally {
        handlingRequest = false
      }
    }, 20)
    let output
    try {
      output = await executeSandbox(
        executable,
        [
          'sandbox',
          '-P',
          'hive-probe',
          '-C',
          locations.source,
          '--',
          process.execPath,
          join(locations.source, 'probe.cjs'),
          JSON.stringify({ ...locations, port: address.port }),
        ],
        { env: environment, cwd: locations.source, timeout: 15_000 },
        join(fixture, `capture-${role}`)
      )
    } finally {
      clearInterval(broker)
    }
    if (brokerError) {
      evidence.results.push({
        role,
        stdout: output.stdout,
        stderr: output.stderr,
        broker_error: brokerError.message,
      })
      throw brokerError
    }
    if (!output.stdout.trim()) {
      evidence.results.push({ role, stdout: output.stdout, stderr: output.stderr })
      throw new Error('Sandbox command exited without its behavior report')
    }
    const result = JSON.parse(output.stdout.trim())
    evidence.results.push({ role, observed: result, stderr: output.stderr.trim() })
    assert.equal(result.source_read, 'allowed')
    assert.equal(result.source_write, role === 'coder' ? 'allowed' : 'EROFS')
    assert.equal(result.scratch_write, 'allowed')
    for (const key of [
      'outside_read',
      'outside_write',
      'credential_read',
      'symlink_read',
      'symlink_write',
    ]) {
      assert.ok(
        ['ENOENT', 'EACCES', 'EPERM', 'EROFS'].includes(result[key]),
        `${role}: ${key} escaped`
      )
    }
    assert.equal(result.direct_tcp, 'EPERM')
    assert.equal(result.mailbox_report, true)
  }
  assert.equal(
    await readFile(join(locations.outside, 'secret.txt'), 'utf8'),
    'synthetic secret sentinel\n'
  )
  evidence.passed = true
} catch (error) {
  evidence.passed = false
  evidence.error = error instanceof Error ? error.message : String(error)
  process.exitCode = 1
} finally {
  await new Promise((resolve) => listener.close(resolve))
  await mkdir(dirname(reportPath), { recursive: true })
  await writeFile(reportPath, `${JSON.stringify(evidence, null, 2)}\n`)
  console.log(JSON.stringify(evidence, null, 2))
}
