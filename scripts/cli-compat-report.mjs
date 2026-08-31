import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const jsonOutput = process.argv.includes('--json')
const strict = process.argv.includes('--strict')

const tierOneClis = ['claude', 'codex', 'gemini', 'opencode']
const additionalClis = ['qwen', 'zcode', 'kimi', 'agy', 'cursor-agent', 'grok', 'pi', 'hermes']

const resolveOnPath = (command) => {
  const executable = process.platform === 'win32' ? 'where.exe' : 'which'
  try {
    const output = execFileSync(executable, [command], {
      encoding: 'utf8',
      env: { ...process.env, PATH: process.env.PATH ?? '' },
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean)
  } catch {
    return undefined
  }
}

const isProtectedWindowsShim = (resolvedPath) => {
  if (process.platform !== 'win32' || !resolvedPath) return false
  const normalized = resolvedPath.replaceAll('/', '\\').toLowerCase()
  return normalized.includes('\\windowsapps\\') && /\.(?:com|exe|cmd|bat)$/i.test(normalized)
}

const inspectCli = (name) => {
  const resolvedPath = resolveOnPath(name)
  if (!resolvedPath) return { name, status: 'missing', path: null }
  if (isProtectedWindowsShim(resolvedPath)) {
    return {
      name,
      path: resolvedPath,
      status: 'protected-shim',
      detail: 'PATH resolves to a WindowsApps app alias; install a standalone CLI instead.',
    }
  }
  return { name, path: resolvedPath, status: 'ok' }
}

const inspectNativeModule = (name) => {
  try {
    const entry = require.resolve(name)
    require(name)
    return {
      name,
      entry,
      nodeAbi: process.versions.modules,
      status: 'ok',
    }
  } catch (error) {
    return {
      name,
      entry: null,
      nodeAbi: process.versions.modules,
      status: 'error',
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  node: {
    abi: process.versions.modules,
    executable: process.execPath,
    version: process.version,
  },
  nativeModules: ['better-sqlite3', 'node-pty'].map(inspectNativeModule),
  clis: [...tierOneClis, ...additionalClis].map((name) => ({
    tier: tierOneClis.includes(name) ? 1 : 2,
    ...inspectCli(name),
  })),
}

const errors = report.nativeModules.filter((item) => item.status === 'error')
const warnings = report.clis.filter((item) => item.status !== 'ok')

if (jsonOutput) {
  console.log(
    JSON.stringify(
      { ...report, summary: { errors: errors.length, warnings: warnings.length } },
      null,
      2
    )
  )
} else {
  console.log(`Hive CLI compatibility report (Node ${report.node.version}, ABI ${report.node.abi})`)
  console.log('')
  console.log('Native modules:')
  for (const item of report.nativeModules) {
    console.log(
      `  ${item.status.toUpperCase().padEnd(15)} ${item.name}${item.detail ? ` — ${item.detail}` : ''}`
    )
  }
  console.log('')
  console.log('Agent CLIs:')
  for (const item of report.clis) {
    const tier = `Tier-${item.tier}`
    console.log(
      `  ${item.status.toUpperCase().padEnd(15)} ${item.name.padEnd(14)} ${tier}${item.path ? ` — ${item.path}` : item.detail ? ` — ${item.detail}` : ''}`
    )
  }
  console.log('')
  console.log(`Summary: ${errors.length} native error(s), ${warnings.length} CLI warning(s)`)
}

if (strict && errors.length > 0) process.exitCode = 1
