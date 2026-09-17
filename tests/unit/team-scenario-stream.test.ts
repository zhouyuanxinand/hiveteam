import { expect, test } from 'vitest'
import { readScenarioLaunchStream } from '../../web/src/api-team-scenario-stream.js'

test('decodes split UTF-8 and line boundaries without losing progress or failures', async () => {
  const member = {
    id: 'alice',
    name: '开发成员',
    role: 'coder',
    state: 'failed',
    error: 'CLI 启动失败',
    duration_ms: 20,
  }
  const result = {
    created: ['alice'],
    reused: [],
    started: [{ id: 'alice', ok: false, error: 'CLI 启动失败', run_id: null }],
    workers: [],
  }
  const bytes = new TextEncoder().encode(
    `${JSON.stringify({ type: 'progress', members: [member] })}\n${JSON.stringify({ type: 'result', result })}\n`
  )
  const progress: unknown[] = []
  const stream = new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7))
      controller.close()
    },
  })
  expect(
    await readScenarioLaunchStream(new Response(stream), (members) => progress.push(members))
  ).toEqual(result)
  expect(progress).toEqual([[member]])
})

test('does not present an interrupted stream as a completed launch', async () => {
  const response = new Response(`${JSON.stringify({ type: 'progress', members: [] })}\n`)
  await expect(readScenarioLaunchStream(response, () => {})).rejects.toThrow(
    'before the final result'
  )
})

test('surfaces the server cause when finalization fails after progress has begun', async () => {
  const response = new Response(
    `${JSON.stringify({ type: 'error', error: 'Workspace was removed' })}\n`
  )
  await expect(readScenarioLaunchStream(response, () => {})).rejects.toThrow(
    'Workspace was removed'
  )
})
