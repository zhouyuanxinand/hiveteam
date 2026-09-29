import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import WebSocket from 'ws'
import { writeCodexCli } from '../helpers/codex-cli.js'
import { startAuthorizedTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

test('two Codex viewers answer each live color query once without swallowing ordinary input', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hive-color-replies-'))
  cleanups.push(() => {
    if (!resolve(root).startsWith(resolve(tmpdir(), 'hive-color-replies-')))
      throw new Error('Unexpected fixture directory')
    rmSync(root, { recursive: true, force: true, maxRetries: 10 })
  })
  const inputPath = join(root, 'stdin.txt')
  const queryPath = join(root, 'query.txt')
  writeFileSync(inputPath, '')
  writeFileSync(queryPath, '0')
  const command = writeCodexCli(
    root,
    `
import { appendFileSync, readFileSync } from 'node:fs'
process.stdin.setRawMode(true)
process.stdin.on('data', chunk => appendFileSync(${JSON.stringify(inputPath)}, chunk))
let last = '0'
setInterval(() => {
  const next = readFileSync(${JSON.stringify(queryPath)}, 'utf8')
  if (next === last) return
  last = next
  process.stdout.write('\\u001b]10;?\\u001b\\\\\\u001b]11;?\\u001b\\\\COLOR_QUERY_' + next + '\\r\\n')
}, 25)
process.stdout.write('COLOR_READY\\r\\n')
process.stdin.resume()
`
  )
  mkdirSync(join(root, 'workspace'))
  const server = await startAuthorizedTestServer({ dataDir: join(root, 'data') })
  cleanups.push(() => server.close())
  const workspace = server.store.createWorkspace(join(root, 'workspace'), 'Color protocol')
  const worker = server.store.addWorker(workspace.id, { name: 'Color terminal', role: 'coder' })
  server.store.configureAgentLaunch(workspace.id, worker.id, {
    command,
    args: [],
    commandPresetId: 'codex',
    presetAugmentationDisabled: true,
  })
  const cookie = await getUiCookie(server.baseUrl)
  const response = await fetch(
    `${server.baseUrl}/api/workspaces/${workspace.id}/agents/${worker.id}/start`,
    { method: 'POST', headers: { cookie } }
  )
  expect(response.status).toBe(201)
  const { run_id: runId } = (await response.json()) as { run_id: string }
  await expect
    .poll(() => server.store.getLiveRun(runId).output, { timeout: 10000 })
    .toContain('COLOR_READY')
  const foreground = '\u001b]10;rgb:dddd/dddd/dddd\u001b\\'
  const background = '\u001b]11;rgb:1111/2222/3333\u0007'
  const connect = async (name: string) => {
    let output = ''
    let answered = 0
    let acknowledgedRound = 0
    const socket = new WebSocket(
      `${server.baseUrl.replace('http:', 'ws:')}/ws/terminal/${runId}/io?clientId=${randomUUID()}`,
      { headers: { cookie } }
    )
    socket.on('message', (data) => {
      output += data.toString()
      // Reply directly to the live query, within Codex's native probe window.
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Native terminal color queries.
      const queries = [...output.matchAll(/\u001b\](10|11);\?(?:\u0007|\u001b\\)/gu)]
      while (answered < queries.length) {
        const query = queries[answered++]
        socket.send(query?.[1] === '10' ? foreground : background)
      }
      while (output.includes(`COLOR_QUERY_${acknowledgedRound + 1}`)) {
        acknowledgedRound += 1
        socket.send(`ROUND_${acknowledgedRound}_${name}`)
      }
    })
    cleanups.push(() => socket.terminate())
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    return { socket, output: () => output }
  }
  const first = await connect('FIRST')
  const second = await connect('SECOND')
  const received = () => readFileSync(inputPath, 'utf8')
  const occurrences = (value: string) => received().split(value).length - 1

  const query = async (round: number) => {
    writeFileSync(queryPath, String(round))
    await expect.poll(first.output).toContain(`COLOR_QUERY_${round}`)
    await expect.poll(second.output).toContain(`COLOR_QUERY_${round}`)
    await expect.poll(received).toContain(`ROUND_${round}_FIRST`)
    await expect.poll(received).toContain(`ROUND_${round}_SECOND`)
  }
  await query(1)
  expect(occurrences(foreground)).toBe(1)
  expect(occurrences(background)).toBe(1)
  await query(2)
  expect(occurrences(foreground)).toBe(2)
  expect(occurrences(background)).toBe(2)

  first.socket.send(foreground)
  first.socket.send('UNREQUESTED_CHECK')
  await expect.poll(received).toContain('UNREQUESTED_CHECK')
  expect(occurrences(foreground)).toBe(2)

  const mixed = `${foreground}human text after a color-like sequence`
  first.socket.send(mixed)
  const otherReply = '\u001b[?2026;2$y'
  first.socket.send(otherReply)
  first.socket.send('FINAL_INPUT_CHECK')
  await expect.poll(received).toContain('FINAL_INPUT_CHECK')
  expect(received()).toContain(mixed)
  expect(received()).toContain(otherReply)
}, 30000)
