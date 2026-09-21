// No model calls. Run before and after a terminal change with the same host and arguments.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { cpus, freemem, platform, release, tmpdir, totalmem } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import Database from 'better-sqlite3'
import WebSocket from 'ws'
import { startAuthorizedTestServer } from '../helpers/test-server.js'

const output = resolve(process.argv[2] ?? '.validation/capacity.json')
mkdirSync(dirname(output), { recursive: true })
const duration = Number(process.env.HIVE_PERF_DURATION_MS ?? 2400)
if (!process.env.HIVE_PLAYWRIGHT_MODULE)
  throw new Error('Set HIVE_PLAYWRIGHT_MODULE to playwright/index.mjs')
const { chromium } = await import(pathToFileURL(process.env.HIVE_PLAYWRIGHT_MODULE).href)
if (process.platform === 'win32' && !process.env.HIVE_TEST_PTY_BACKEND)
  process.env.HIVE_TEST_PTY_BACKEND = 'winpty'
const browser = await chromium.launch({ headless: true })
const percentile = (values: number[], p: number) => {
  const sorted = values.toSorted((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? null
}
const results: unknown[] = []
const environment = {
  os: platform(),
  release: release(),
  cpu: cpus()[0]?.model,
  logical_cpus: cpus().length,
  total_memory: totalmem(),
  free_memory: freemem(),
  node: process.version,
  fixture: 'capacity-cli-v1',
  pty_backend:
    process.platform === 'win32'
      ? process.env.HIVE_TEST_PTY_BACKEND === 'winpty'
        ? 'winpty'
        : 'ConPTY'
      : 'POSIX',
  browser: browser.version(),
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  dirty: true,
  seed: 1,
  duration_ms: duration,
  model_cost: null,
  model_quality: null,
}
try {
  for (const count of process.env.HIVE_PERF_WORKERS?.split(',').map(Number) ?? [1, 4, 8])
    for (const workload of process.env.HIVE_PERF_WORKLOADS?.split(',') ?? [
      'idle',
      'steady',
      'burst',
      'history',
    ]) {
      const root = mkdtempSync(join(tmpdir(), 'hive-capacity-')),
        project = join(root, '中文 空格')
      mkdirSync(project)
      const server = await startAuthorizedTestServer({ dataDir: join(root, 'state') })
      const sockets: WebSocket[] = []
      let fixtureDatabase: Database.Database | undefined
      const context = await browser.newContext(),
        page = await context.newPage()
      try {
        const session = await fetch(`${server.baseUrl}/api/ui/session`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ bootstrap_token: server.store.createUiBootstrap() }),
        })
        const cookie = session.headers.get('set-cookie')?.split(';')[0]
        assert.ok(cookie)
        const limits = {
          max_running_total: count + 1,
          max_running_per_workspace: count + 1,
          max_workers_per_workspace: count,
          max_verification_per_workspace: 1,
        }
        const quota = await fetch(`${server.baseUrl}/api/resources`, {
          method: 'PUT',
          headers: { cookie, 'content-type': 'application/json' },
          body: JSON.stringify(limits),
        })
        assert.equal(quota.status, 200)
        const response = await fetch(`${server.baseUrl}/api/workspaces`, {
          method: 'POST',
          headers: { cookie, 'content-type': 'application/json' },
          body: JSON.stringify({
            path: project,
            name: 'Capacity fixture',
            initialization_mode: 'basic',
            autostart_orchestrator: false,
          }),
        })
        assert.equal(response.status, 201)
        const workspace = (await response.json()) as { id: string }
        const workers = []
        for (let i = 0; i < count; i++)
          workers.push(
            server.store.addWorker(workspace.id, {
              name: `Worker ${i}`,
              role: i === 0 ? 'coder' : 'tester',
            })
          )
        const agents = [`${workspace.id}:orchestrator`, ...workers.map((w) => w.id)]
        const runs = []
        for (const agent of agents) {
          server.store.configureAgentLaunch(workspace.id, agent, {
            command: process.execPath,
            args: [
              resolve('tests/fixtures/capacity-cli.cjs'),
              agent === agents[0] ? 'idle' : workload === 'history' ? 'steady' : workload,
              resolve('src/cli/team.ts'),
            ],
          })
          runs.push(
            await server.store.startAgent(workspace.id, agent, {
              hivePort: new URL(server.baseUrl).port,
            })
          )
        }
        const first = runs[1]
        assert.ok(first)
        const db = new Database(join(server.dataDir, 'runtime.sqlite'))
        fixtureDatabase = db
        if (workload === 'history')
          db.transaction(() => {
            const insert = db.prepare(
              "INSERT INTO dispatches(id,workspace_id,to_agent_id,text,status,created_at) VALUES(?,?,?,?,'cancelled',?)"
            )
            for (let i = 0; i < 1500; i++)
              insert.run(
                randomUUID(),
                workspace.id,
                workers[0]?.id,
                `history ${i}`,
                Date.now() - 86400000
              )
            // Match a completed cancellation's delivery ledger. The insert
            // trigger creates pending records even for synthetic historical rows.
            db.prepare(
              "UPDATE message_deliveries SET state='resolved',reason='Synthetic historical cancellation' WHERE workspace_id=? AND dispatch_id IN (SELECT id FROM dispatches WHERE workspace_id=? AND status='cancelled')"
            ).run(workspace.id, workspace.id)
          })()
        const latencies: number[] = [],
          httpTimes: number[] = [],
          dbTimes: number[] = []
        let healthyBytes = 0,
          slowBytes = 0,
          peakQueued = 0,
          peakRss = 0,
          healthyLast = '',
          slowClosed = false
        const viewer = async (id: string, ack: boolean) => {
          const base = server.baseUrl.replace('http:', 'ws:') + `/ws/terminal/${first.runId}`
          const control = new WebSocket(`${base}/control?clientId=${id}`, { headers: { cookie } }),
            io = new WebSocket(`${base}/io?clientId=${id}`, { headers: { cookie } })
          sockets.push(control, io)
          io.on('message', (raw) => {
            const text = raw.toString()
            if (ack) {
              healthyBytes += Buffer.byteLength(text)
              healthyLast = (healthyLast + text).slice(-300000)
              for (const match of text.matchAll(/\[perf:(\d+):\d+\]/gu))
                latencies.push(Date.now() - Number(match[1]))
              if (control.readyState === 1)
                control.send(JSON.stringify({ type: 'output_ack', bytes: Buffer.byteLength(text) }))
            } else slowBytes += Buffer.byteLength(text)
          })
          if (!ack)
            io.on('close', () => {
              slowClosed = true
            })
          await Promise.all([once(control, 'open'), once(io, 'open')])
          return { control, io }
        }
        const healthy = await viewer(randomUUID(), true)
        await viewer(randomUUID(), false)
        await context.addCookies([
          {
            name: cookie.slice(0, cookie.indexOf('=')),
            value: cookie.slice(cookie.indexOf('=') + 1),
            url: server.baseUrl,
          },
        ])
        await page.goto(server.baseUrl)
        await page.evaluate(
          ({ base, runId }) => {
            const id = crypto.randomUUID(),
              control = new WebSocket(`${base}/ws/terminal/${runId}/control?clientId=${id}`),
              io = new WebSocket(`${base}/ws/terminal/${runId}/io?clientId=${id}`)
            ;(window as any).perf = { bytes: 0, latency: [], heap: 0 }
            io.onmessage = (event) => {
              const text = String(event.data)
              ;(window as any).perf.bytes += new TextEncoder().encode(text).length
              for (const match of text.matchAll(/\[perf:(\d+):\d+\]/g))
                (window as any).perf.latency.push(Date.now() - Number(match[1]))
              if (control.readyState === 1)
                control.send(
                  JSON.stringify({
                    type: 'output_ack',
                    bytes: new TextEncoder().encode(text).length,
                  })
                )
              document.title = `Fixture ${(window as any).perf.bytes}`
            }
          },
          { base: server.baseUrl.replace('http:', 'ws:'), runId: first.runId }
        )
        await delay(200)
        const lag = monitorEventLoopDelay({ resolution: 10 })
        lag.enable()
        const cpu = process.cpuUsage(),
          start = performance.now()
        for (const run of runs.slice(1)) server.store.writeRunInput(run.runId, 'HIVE_PERF_BEGIN\r')
        const taskStart = performance.now()
        const dispatches = []
        const taskCount = Number(process.env.HIVE_PERF_TASKS ?? count)
        for (let index = 0; index < taskCount; index++) {
          const worker = workers[index % count]
          assert.ok(worker)
          dispatches.push(
            await server.store.dispatchTask(workspace.id, worker.id, 'Deterministic fixture task')
          )
        }
        const taskLatencies: number[] = []
        const seen = new Set<string>()
        while (performance.now() - start < duration) {
          const t = performance.now()
          const request = await fetch(
            `${server.baseUrl}/api/ui/workspaces/${workspace.id}/delivery`,
            { headers: { cookie } }
          )
          assert.equal(request.status, 200)
          await request.json()
          httpTimes.push(performance.now() - t)
          const d = performance.now()
          db.prepare('SELECT COUNT(*) FROM dispatches WHERE workspace_id=?').get(workspace.id)
          dbTimes.push(performance.now() - d)
          for (const dispatch of dispatches)
            if (
              !seen.has(dispatch.id) &&
              server.store.getDispatch(workspace.id, dispatch.id)?.status === 'reported'
            ) {
              seen.add(dispatch.id)
              taskLatencies.push(performance.now() - taskStart)
            }
          for (const metric of server.terminalMetrics())
            for (const viewer of metric.viewers)
              peakQueued = Math.max(
                peakQueued,
                viewer.queued_bytes + viewer.unacked_bytes + viewer.transport_bytes
              )
          peakRss = Math.max(peakRss, process.memoryUsage().rss)
          await delay(30)
        }
        const recoveryStart = performance.now()
        const recovery = server.store.recoveryIndex.page(workspace.id, project, {
          id: agents[0] ?? '',
          name: 'Orchestrator',
          role: 'orchestrator',
        })
        const recoveryMs = performance.now() - recoveryStart
        const browserMetrics = await page.evaluate(() => ({
          ...(window as any).perf,
          heap: (performance as any).memory?.usedJSHeapSize ?? null,
        }))
        const cpuUsed = process.cpuUsage(cpu)
        lag.disable()
        const snapshot = server.store.resources.getSnapshot()
        results.push({
          workers: count,
          workload,
          limits,
          effective_limits: snapshot.limits,
          main_executions: { orchestrator: 1, worker: count, workspace_shell: 0, verification: 0 },
          duration_ms: performance.now() - start,
          rss_peak: peakRss,
          rss_steady: process.memoryUsage().rss,
          cpu_ms: (cpuUsed.user + cpuUsed.system) / 1000,
          event_loop_p95_ms: lag.percentile(95) / 1e6,
          terminal_latency_ms: {
            p50: percentile(latencies, 0.5),
            p95: percentile(latencies, 0.95),
            samples: latencies.length,
          },
          http_ms: { p50: percentile(httpTimes, 0.5), p95: percentile(httpTimes, 0.95) },
          sqlite_ms: { p50: percentile(dbTimes, 0.5), p95: percentile(dbTimes, 0.95) },
          recovery_ms: recoveryMs,
          recovery_total: recovery.total,
          peak_viewer_buffer_bytes: peakQueued,
          healthy_bytes: healthyBytes,
          slow_bytes: slowBytes,
          slow_disconnected: slowClosed,
          browser: {
            bytes: browserMetrics.bytes,
            latency_p95_ms: percentile(browserMetrics.latency, 0.95),
            heap_bytes: browserMetrics.heap,
          },
          task_successes: seen.size,
          task_total: taskCount,
          timed_out_tasks: taskCount - seen.size,
          task_states: dispatches.map((dispatch) => {
            const current = server.store.getDispatch(workspace.id, dispatch.id)
            return { id: dispatch.id, state: current?.status, error: current?.lastError }
          }),
          delivery_states: db
            .prepare('SELECT kind,state,reason FROM message_deliveries WHERE workspace_id=?')
            .all(workspace.id),
          task_duration_p95_ms: percentile(taskLatencies, 0.95),
          manual_interventions: 0,
          rework_rounds: 0,
          model_cost: null,
        })
        healthy.control.close()
        db.close()
        fixtureDatabase = undefined
        writeFileSync(output, JSON.stringify({ environment, results }, null, 2))
        console.log(
          `${count} ${workload}: ${seen.size}/${taskCount}; healthy bytes ${healthyBytes}; queued ${peakQueued}`
        )
      } finally {
        fixtureDatabase?.close()
        await context.close()
        for (const socket of sockets) socket.terminate()
        await server.close()
        rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
      }
    }
} finally {
  await browser.close()
}
// All owned PTYs, sockets, runtime and browser have been closed above. node-pty's
// Windows backend retains native handles in this standalone measurement process.
process.exit(0)
