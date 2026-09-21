import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { installedRuntimeAcceptance, verifyInstalledRestart } from './pack-runtime-acceptance.mjs'
import { requestUiBootstrap } from './ui-launcher.mjs'

const root = process.cwd()
const tempDir = mkdtempSync(join(tmpdir(), 'hive-pack-smoke-'))
let packedFile
let acceptanceReceipt
const binLinkName = (name) => (process.platform === 'win32' ? `${name}.cmd` : name)
const runtimeStartTimeoutMs = process.platform === 'win32' ? 60_000 : 5_000
// A cold npm cache can take longer than a minute to install native runtime
// dependencies on macOS and Linux. Keep the same budget on every platform so
// the smoke test verifies the package rather than failing on an arbitrary
// platform-specific cutoff.
const npmInstallTimeoutMs = 180_000
const activeNodeDir = dirname(process.execPath)
const activeNpmCli = join(activeNodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')

const withActiveNodeEnv = (env = {}) => {
  const mergedEnv = { ...process.env, ...env }
  mergedEnv.PATH = [activeNodeDir, mergedEnv.PATH].filter(Boolean).join(delimiter)
  return mergedEnv
}

const withActiveNodeOptions = (options = {}) => ({
  ...options,
  env: withActiveNodeEnv(options.env),
})

const runNpm = (args, options = {}) => {
  if (existsSync(activeNpmCli)) {
    return execFileSync(process.execPath, [activeNpmCli, ...args], withActiveNodeOptions(options))
  }

  return process.platform === 'win32'
    ? execFileSync('cmd.exe', ['/d', '/s', '/c', 'npm', ...args], withActiveNodeOptions(options))
    : execFileSync('npm', args, withActiveNodeOptions(options))
}

const parseSinglePackResult = (packJson) => {
  const parsed = JSON.parse(packJson)
  const results = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object'
      ? Object.values(parsed)
      : []
  const [result] = results
  if (results.length !== 1 || !result || typeof result.filename !== 'string') {
    throw new Error('npm pack --json returned invalid package metadata')
  }
  return result
}

const logPhase = (phase) => {
  process.stdout.write(`[pack-smoke] ${phase}\n`)
}

const removePath = (path) => {
  rmSync(path, {
    force: true,
    maxRetries: process.platform === 'win32' ? 20 : 0,
    recursive: true,
    retryDelay: 100,
  })
}

const waitFor = async (predicate, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    const value = await predicate()
    if (value) return value
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 25))
  }
  throw new Error('Timed out waiting for packaged hive runtime to start')
}

const stopChild = async (child) => {
  if (child.exitCode !== null || child.signalCode !== null) return

  await new Promise((resolveExit) => {
    const forceKill = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }, 2000)

    child.once('exit', () => {
      clearTimeout(forceKill)
      resolveExit()
    })

    if (process.platform === 'win32' && child.pid) {
      try {
        execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
      } catch {
        child.kill('SIGKILL')
      }
      return
    }

    child.kill('SIGTERM')
  })
}

try {
  logPhase('packing')
  const packJson = runNpm(['pack', '--json'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const packResult = parseSinglePackResult(packJson)
  packedFile = resolve(root, packResult.filename)
  const packageSpecifier = `file:${packedFile.replaceAll('\\', '/')}`
  writeFileSync(
    join(tempDir, 'package.json'),
    `${JSON.stringify(
      {
        allowScripts: {
          [packageSpecifier]: true,
          'better-sqlite3': true,
          'node-pty': true,
        },
        dependencies: { hiveteam: packageSpecifier },
        name: 'hive-pack-smoke-consumer',
        private: true,
        version: '0.0.0',
      },
      null,
      2
    )}\n`
  )

  logPhase('installing packaged runtime')
  runNpm(
    ['install', '--silent', '--no-audit', '--no-fund', '--prefer-offline', '--prefix', tempDir],
    {
      stdio: 'inherit',
      timeout: npmInstallTimeoutMs,
    }
  )

  const packageName = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name
  const packageRoot = join(tempDir, 'node_modules', ...packageName.split('/'))
  const hiveBin = join(tempDir, 'node_modules', '.bin', binLinkName('hive'))
  const teamBin = join(tempDir, 'node_modules', '.bin', 'team')
  const teamCmdBin = join(tempDir, 'node_modules', '.bin', 'team.cmd')
  const internalTeam = join(packageRoot, 'dist', 'bin', 'team')
  const internalTeamCmd = join(packageRoot, 'dist', 'bin', 'team.cmd')
  const internalTeamLauncher = process.platform === 'win32' ? internalTeamCmd : internalTeam
  const packagedRuntimeEntry = join(packageRoot, 'dist', 'src', 'cli', 'hive.js')

  if (!existsSync(hiveBin)) throw new Error('Packaged hive bin was not linked')
  if (existsSync(teamBin) || existsSync(teamCmdBin)) {
    throw new Error('team must not be exposed as a global package bin')
  }
  if (!existsSync(internalTeam)) throw new Error('Internal dist/bin/team is missing')
  if (!existsSync(internalTeamCmd)) throw new Error('Internal dist/bin/team.cmd is missing')

  logPhase('starting packaged runtime')
  // Starting a .cmd shim through shell:true on Windows can detach its Node
  // grandchild when the shell is stopped, leaving runtime.sqlite locked. The
  // linked shim is verified above; launch the packaged JS entry directly so
  // the smoke test owns the actual runtime process it must shut down.
  const runtimeCommand =
    process.platform === 'win32'
      ? { args: [packagedRuntimeEntry, '--port', '0'], file: process.execPath }
      : { args: ['--port', '0'], file: hiveBin }
  const child = spawn(runtimeCommand.file, runtimeCommand.args, {
    env: withActiveNodeEnv({
      HIVE_DATA_DIR: join(tempDir, 'data'),
    }),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString()
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString()
  })

  try {
    const port = await waitFor(() => {
      const match = stdout.match(/Hive running at http:\/\/127\.0\.0\.1:(\d+)/)
      return match?.[1]
    }, runtimeStartTimeoutMs).catch((error) => {
      const childOutput = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n')
      throw new Error(`${error.message}${childOutput ? `\n${childOutput}` : ''}`)
    })
    const response = await fetch(`http://127.0.0.1:${port}/`)
    if (response.status !== 200) {
      throw new Error(`Packaged runtime root returned ${response.status}`)
    }
    const html = await response.text()
    if (!html.includes('<div id="root"></div>')) {
      throw new Error('Packaged runtime did not serve the bundled web UI')
    }

    const sessionResponse = await fetch(`http://127.0.0.1:${port}/api/ui/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bootstrap_token: await requestUiBootstrap(child) }),
    })
    const cookie = sessionResponse.headers.get('set-cookie')?.split(';')[0]
    if (!sessionResponse.ok || !cookie) {
      throw new Error(`Packaged runtime session returned ${sessionResponse.status}`)
    }

    const workspaceResponse = await fetch(`http://127.0.0.1:${port}/api/workspaces`, {
      body: JSON.stringify({
        autostart_orchestrator: false,
        initialization_mode: 'basic',
        name: 'Pack Smoke',
        path: tempDir,
      }),
      headers: {
        'content-type': 'application/json',
        cookie,
      },
      method: 'POST',
    })
    if (workspaceResponse.status !== 201) {
      throw new Error(`Packaged runtime workspace create returned ${workspaceResponse.status}`)
    }
    const workspace = await workspaceResponse.json()
    const agentId = `${workspace.id}:orchestrator`
    const configure = await fetch(
      `http://127.0.0.1:${port}/api/workspaces/${workspace.id}/agents/${encodeURIComponent(agentId)}/config`,
      {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ command: internalTeamLauncher, args: ['list'] }),
      }
    )
    if (!configure.ok)
      throw new Error(`Packaged team shim configuration failed: ${configure.status}`)
    const policyUrl = `http://127.0.0.1:${port}/api/ui/workspaces/${workspace.id}/agents/${encodeURIComponent(agentId)}/execution-policy`
    const policyResponse = await fetch(policyUrl, { headers: { cookie } })
    if (!policyResponse.ok)
      throw new Error(`Packaged policy preview returned ${policyResponse.status}`)
    const policy = await policyResponse.json()
    // The fixture intentionally runs the packaged team executable as an agent.
    // Authorize that exact executable through the real local management boundary.
    const grant = await fetch(policyUrl, {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        profile: 'trusted_unsafe',
        expected_cli_fingerprint: policy.cli_fingerprint,
        expected_cli_version: policy.cli_version,
        policy_revision: policy.policy_revision,
        acknowledge_unsafe: true,
      }),
    })
    if (!grant.ok) throw new Error(`Packaged fixture authorization returned ${grant.status}`)
    const start = await fetch(
      `http://127.0.0.1:${port}/api/workspaces/${workspace.id}/agents/${encodeURIComponent(agentId)}/start`,
      {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }
    )
    if (!start.ok) {
      throw new Error(`Packaged internal team launcher failed: ${await start.text()}`)
    }
    logPhase('runtime responded')
    acceptanceReceipt = await installedRuntimeAcceptance({
      baseUrl: `http://127.0.0.1:${port}`,
      cookie,
      packageRoot,
      tempDir,
      workspace,
      bootstrap: () => requestUiBootstrap(child),
      root,
    })
  } finally {
    logPhase('stopping packaged runtime')
    await stopChild(child)
  }

  if (stderr) {
    console.warn(stderr.trim())
  }
  const restarted = spawn(runtimeCommand.file, runtimeCommand.args, {
    env: withActiveNodeEnv({ HIVE_DATA_DIR: join(tempDir, 'data') }),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  let restartOutput = ''
  restarted.stdout.on('data', (chunk) => {
    restartOutput += chunk.toString()
  })
  restarted.stderr.on('data', (chunk) => process.stderr.write(chunk))
  try {
    const port = await waitFor(
      () => restartOutput.match(/Hive running at http:\/\/127\.0\.0\.1:(\d+)/)?.[1],
      runtimeStartTimeoutMs
    )
    const response = await fetch(`http://127.0.0.1:${port}/api/ui/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bootstrap_token: await requestUiBootstrap(restarted) }),
    })
    const cookie = response.headers.get('set-cookie')?.split(';')[0]
    if (!cookie || !acceptanceReceipt)
      throw new Error('Restart did not establish a local UI session')
    await verifyInstalledRestart(`http://127.0.0.1:${port}`, cookie, acceptanceReceipt)
  } finally {
    await stopChild(restarted)
  }
} finally {
  logPhase('cleaning temporary files')
  if (packedFile) removePath(packedFile)
  removePath(tempDir)
}
