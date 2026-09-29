import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { release, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { npmCommand } from './npm-command.mjs'
import { installedRuntimeAcceptance, verifyInstalledRestart } from './pack-runtime-acceptance.mjs'
import { startInstalledRuntime } from './pack-runtime-process.mjs'
import { verifyTeamLauncher } from './pack-team-launcher.mjs'
import { createReleaseArtifact, verifyReleaseArtifact } from './release-artifact.mjs'

const repository = fileURLToPath(new URL('../', import.meta.url))
const environment = {
  node_version: process.version,
  platform: process.platform,
  arch: process.arch,
  os_release: release(),
  pty_backend: process.platform === 'win32' ? 'conpty' : 'unix',
}

const writeReport = (reportPath, receipt, emit = true) => {
  const json = `${JSON.stringify(receipt, null, 2)}\n`
  if (reportPath) {
    mkdirSync(dirname(reportPath), { recursive: true })
    writeFileSync(reportPath, json)
  }
  if (emit) process.stdout.write(json)
}

const smoke = async (options) => {
  const receipt = { schema_version: 1, status: 'failed', environment, checks: {} }
  const parent = resolve(tmpdir())
  let temporary
  let stage = 'environment'
  const phase = (next) => {
    stage = next
    process.stdout.write(`[pack-smoke] ${stage}\n`)
  }
  try {
    if (process.platform === 'win32') {
      assert.ok(
        Number(release().split('.')[2]) >= 18309,
        'ConPTY acceptance requires Windows build 18309 or later'
      )
    }
    for (const key of ['platform', 'arch', 'node']) {
      const expected = options[`expected-${key}`]
      const actual = key === 'node' ? process.version.slice(1) : process[key]
      if (expected) assert.equal(actual, expected, `Unexpected ${key}`)
    }
    receipt.checks.environment = { status: 'passed' }
    temporary = mkdtempSync(join(parent, 'hive-pack-验收 '))
    phase('verify artifact')
    const manifestPath =
      options.artifact ??
      process.env.HIVE_RELEASE_MANIFEST ??
      (await createReleaseArtifact({ repository, outputDirectory: join(temporary, 'artifact') }))
        .manifestPath
    const { manifest, tarballPath } = await verifyReleaseArtifact(manifestPath)
    receipt.artifact = manifest
    receipt.checks.artifact_digest = { status: 'passed', sha256: manifest.tarball.sha256 }

    const consumer = join(temporary, 'consumer 安装')
    const workspacePath = join(temporary, 'workspace 中文 path')
    const caller = join(temporary, 'caller 工作目录')
    const dataDir = join(temporary, 'state 数据')
    for (const directory of [consumer, workspacePath, caller, dataDir]) mkdirSync(directory)
    // npm's file specifier is a filesystem path, not a percent-encoded URL.
    const specifier = `file:${tarballPath.replaceAll('\\', '/')}`
    writeFileSync(
      join(consumer, 'package.json'),
      `${JSON.stringify(
        {
          name: 'hive-pack-smoke-consumer',
          private: true,
          version: '0.0.0',
          dependencies: { [manifest.package_name]: specifier },
        },
        null,
        2
      )}\n`
    )
    phase('install packaged runtime')
    const npm = npmCommand(
      [
        'install',
        '--no-audit',
        '--no-fund',
        '--prefer-offline',
        `--ignore-scripts=${options['ignore-scripts'] === true}`,
      ],
      {
        cwd: consumer,
        stdio: 'inherit',
        timeout: 180_000,
      }
    )
    execFileSync(npm.file, npm.args, npm.options)
    const packageRoot = join(consumer, 'node_modules', ...manifest.package_name.split('/'))
    const installed = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
    assert.equal(installed.name, manifest.package_name)
    assert.equal(installed.version, manifest.version)
    receipt.checks.install = {
      status: 'passed',
      lifecycle_scripts: options['ignore-scripts'] ? 'disabled' : 'enabled',
      consumer_lock_sha256: createHash('sha256')
        .update(readFileSync(join(consumer, 'package-lock.json')))
        .digest('hex'),
    }
    const bins = join(consumer, 'node_modules', '.bin')
    assert.ok(
      existsSync(join(bins, process.platform === 'win32' ? 'hive.cmd' : 'hive')),
      'hive bin missing'
    )
    for (const name of ['team', 'team.cmd']) {
      assert.ok(!existsSync(join(bins, name)), 'team must not be a global package bin')
      assert.ok(existsSync(join(packageRoot, 'dist/bin', name)), `Internal ${name} missing`)
    }
    const launcher = join(
      packageRoot,
      'dist/bin',
      process.platform === 'win32' ? 'team.cmd' : 'team'
    )
    const runtimeOptions = {
      entry: join(packageRoot, 'dist/src/cli/hive.js'),
      cwd: caller,
      dataDir,
    }
    phase('installed HTTP, team and PTY acceptance')
    const runtime = await startInstalledRuntime(runtimeOptions)
    let accepted
    try {
      const response = await fetch(`${runtime.baseUrl}/`)
      assert.equal(response.status, 200)
      assert.ok((await response.text()).includes('<div id="root"></div>'), 'Bundled UI missing')
      const created = await fetch(`${runtime.baseUrl}/api/workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: runtime.cookie },
        body: JSON.stringify({
          autostart_orchestrator: false,
          initialization_mode: 'basic',
          name: 'Pack Smoke 中文',
          path: workspacePath,
        }),
      })
      assert.equal(created.status, 201, await created.clone().text())
      const workspace = await created.json()
      receipt.checks.http_workspace = {
        status: 'passed',
        workspace_id: workspace.id,
        path: workspace.path,
        launch_cwd: caller,
        package_root: packageRoot,
      }
      receipt.checks.team_launcher = await verifyTeamLauncher({ ...runtime, workspace, launcher })
      accepted = await installedRuntimeAcceptance({
        ...runtime,
        packageRoot,
        tempDir: temporary,
        workspace,
        root: repository,
      })
      Object.assign(receipt.checks, accepted.checks)
    } finally {
      await runtime.stop()
    }
    phase('restart with persisted data')
    const restarted = await startInstalledRuntime(runtimeOptions)
    try {
      const result = await verifyInstalledRestart(restarted.baseUrl, restarted.cookie, accepted)
      Object.assign(receipt.checks, result.checks)
    } finally {
      await restarted.stop()
    }
    receipt.status = 'passed'
  } catch (error) {
    receipt.failure = { stage, message: error.message, stack: error.stack }
    process.stderr.write(`${error.stack}\n`)
  } finally {
    if (temporary) {
      try {
        assert.equal(dirname(resolve(temporary)), parent, 'Unexpected smoke temporary directory')
        rmSync(temporary, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
        receipt.checks.cleanup = { status: 'passed' }
      } catch (error) {
        receipt.status = 'failed'
        receipt.checks.cleanup = { status: 'failed', message: error.message }
      }
    }
  }
  writeReport(options.report, receipt)
  return receipt.status === 'passed' ? 0 : 1
}

const main = async () => {
  const { values } = parseArgs({
    options: {
      ...Object.fromEntries(
        ['artifact', 'report', 'expected-platform', 'expected-arch', 'expected-node'].map((key) => [
          key,
          { type: 'string' },
        ])
      ),
      'ignore-scripts': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  })
  return smoke(values)
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
