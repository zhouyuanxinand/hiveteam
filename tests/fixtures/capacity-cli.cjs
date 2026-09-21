const { spawn } = require('node:child_process')
const [mode = 'idle', teamPath] = process.argv.slice(2)
let input = '',
  sequence = 0,
  started = false,
  blocked = false
const reported = new Set()
process.stdin.setEncoding('utf8')
process.stdout.on('drain', () => {
  blocked = false
})
process.stdin.on('data', (chunk) => {
  input = (input + chunk).slice(-64000)
  if (input.includes('HIVE_PERF_BEGIN')) started = true
  if (process.env.HIVE_AGENT_ID?.endsWith(':orchestrator')) return
  for (const match of input.matchAll(/dispatch_id:\s*([a-f0-9-]{36})/g)) {
    const id = match[1]
    if (reported.has(id)) continue
    reported.add(id)
    const args = teamPath.endsWith('.ts')
      ? [
          '--import',
          require('node:url').pathToFileURL(
            require.resolve('tsx', { paths: [require('node:path').dirname(teamPath)] })
          ).href,
          teamPath,
        ]
      : [teamPath]
    const report = spawn(
      process.execPath,
      [...args, 'report', 'Fixture complete', '--dispatch', id, '--outcome', 'success'],
      { env: process.env, stdio: 'ignore', windowsHide: true }
    )
    report.on('close', (code) => process.stdout.write(`REPORT_EXIT:${code}\r\n`))
  }
})
setInterval(
  () => {
    if (!started || blocked) return
    const now = Date.now(),
      payload = mode === 'burst' ? '输出中文✓'.repeat(1800) : mode === 'idle' ? '' : 'x'.repeat(120)
    if (mode !== 'idle')
      blocked = !process.stdout.write(`[perf:${now}:${sequence++}]${payload}\r\n`)
  },
  mode === 'burst' ? 8 : 25
)
process.stdout.write('FIXTURE_READY\r\n')
