const { spawn } = require('node:child_process')
const { dirname } = require('node:path')
const { pathToFileURL } = require('node:url')
const [team] = process.argv.slice(2)
const loader = team.endsWith('.ts')
  ? ['--import', pathToFileURL(require.resolve('tsx', { paths: [dirname(team)] })).href]
  : []
const invoke = (args) => {
  const child = spawn(process.execPath, [...loader, team, ...args], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdout.pipe(process.stdout)
  child.stderr.pipe(process.stderr)
  child.on('close', (code) => process.stdout.write(`TEAM_EXIT:${code}\r\n`))
}
const grandchild = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
  stdio: 'ignore',
  windowsHide: true,
})
process.stdout.write(`CHILD_PID:${grandchild.pid}\r\nREADY 中文\r\n`)
let input = ''
const reports = new Set()
let sent = false
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  process.stdout.write(`ECHO:${chunk}`)
  input = (input + chunk).slice(-64000)
  if (process.env.HIVE_AGENT_ID?.endsWith(':orchestrator')) {
    if (!sent && input.includes('HIVE_ACCEPT_SEND')) {
      sent = true
      invoke(['send', 'Fixture worker', 'Release acceptance 中文'])
    }
    for (const match of input.matchAll(/HIVE_ACCEPT_CANCEL:([a-f0-9-]{36})/g))
      invoke(['cancel', '--dispatch', match[1], 'Acceptance cancellation'])
  } else
    for (const match of input.matchAll(/dispatch_id:\s*([a-f0-9-]{36})/g)) {
      if (reports.has(match[1])) continue
      reports.add(match[1])
      invoke(['report', 'Fixture success 中文', '--dispatch', match[1], '--outcome', 'success'])
    }
})
