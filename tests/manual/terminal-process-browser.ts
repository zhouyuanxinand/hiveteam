// Optional browser acceptance: HIVE_PLAYWRIGHT_MODULE points at playwright/index.mjs.
// Uses a disposable SQLite database, a real PTY, HTTP and terminal WebSockets.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'vite'
import { startAuthorizedTestServer as startTestServer } from '../helpers/test-server.js'

const modulePath = process.env.HIVE_PLAYWRIGHT_MODULE
if (!modulePath) throw new Error('Set HIVE_PLAYWRIGHT_MODULE to playwright/index.mjs')
const { chromium } = await import(pathToFileURL(modulePath).href)
const directory = mkdtempSync(join(tmpdir(), 'hive-terminal-disclosure-qa-'))
const workspacePath = join(directory, 'workspace')
mkdirSync(workspacePath)
const server = await startTestServer({ dataDir: join(directory, 'state') })
const browser = await chromium.launch({ headless: true })
const errors: string[] = []
process.env.HIVE_RUNTIME_PORT = new URL(server.baseUrl).port
const vite = await createServer({
  configFile: resolve('web/vite.config.ts'),
  cacheDir: join(directory, 'vite-cache'),
  server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
  plugins: [
    {
      name: 'terminal-disclosure-preview',
      configureServer(preview) {
        preview.middlewares.use('/__terminal_disclosure_qa', (_request, response) => {
          response.setHeader('content-type', 'text/html; charset=utf-8')
          response.end(
            '<!doctype html><html lang="zh"><head><meta charset="utf-8"></head><body></body></html>'
          )
        })
      },
    },
  ],
})
try {
  await vite.listen()
  const origin = vite.resolvedUrls?.local[0]
  assert.ok(origin)
  const workspace = server.store.createWorkspace(workspacePath, 'Terminal disclosure QA')
  const worker = server.store.addWorker(workspace.id, { name: 'QA member', role: 'coder' })
  server.store.configureAgentLaunch(workspace.id, worker.id, {
    command: process.execPath,
    args: [resolve('tests/fixtures/terminal-process-cli.cjs')],
  })
  const run = await server.store.startAgent(workspace.id, worker.id, {
    hivePort: new URL(server.baseUrl).port,
  })
  const deadline = Date.now() + 10000
  while (server.store.getLiveRun(run.runId).status === 'starting' && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(server.store.getLiveRun(run.runId).status, 'running')

  for (const size of [
    { width: 1100, height: 780 },
    { width: 390, height: 720 },
  ]) {
    const context = await browser.newContext({ viewport: size })
    await context.grantPermissions(['local-network-access'], { origin })
    const page = await context.newPage()
    page.on('pageerror', (error: Error) => errors.push(error.message))
    page.on('console', (message: { type: () => string; text: () => string }) => {
      if (message.type() === 'error')
        errors.push(message.text().replace(/token=[^&'\s]+/g, 'token=[redacted]'))
    })
    await page.goto(new URL('__terminal_disclosure_qa', origin).href)
    await page.evaluate(async (bootstrap: string) => {
      const session = await fetch('/api/ui/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bootstrap_token: bootstrap }),
      })
      if (!session.ok) throw new Error('Could not establish test UI session')
    }, server.store.createUiBootstrap())
    const moduleUrl = `/@fs/${resolve('tests/fixtures/terminal-process-preview.tsx').replaceAll('\\', '/')}`
    await page.evaluate(
      async ({
        moduleUrl,
        workspaceId,
        agentId,
        runId,
      }: {
        moduleUrl: string
        workspaceId: string
        agentId: string
        runId: string
      }) => {
        const fixture = await import(/* @vite-ignore */ moduleUrl)
        fixture.mount(workspaceId, agentId, runId)
      },
      { moduleUrl, workspaceId: workspace.id, agentId: worker.id, runId: run.runId }
    )
    const history = page.getByRole('region', { name: '终端消息' })
    await history.waitFor({ state: 'visible', timeout: 20000 })
    assert.equal(await history.locator('details').count(), 2)
    assert.equal(await history.locator('details[open]').count(), 0)
    assert.equal(await history.getByText(/Ran Get-ChildItem/).isVisible(), false)
    assert.equal(
      await history.getByText('• 已找到文档，正在确认成员的工作状态。').isVisible(),
      true
    )
    assert.equal(await page.locator('textarea').count(), 1)
    assert.equal(await page.locator('textarea').isVisible(), true)
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false
    )
    await page.screenshot({ path: join(directory, `collapsed-${size.width}.png`) })

    const summary = history.locator('summary').first()
    await summary.focus()
    await page.keyboard.press('Enter')
    assert.equal(await history.getByText(/Ran Get-ChildItem/).isVisible(), true)
    await page.screenshot({ path: join(directory, `expanded-${size.width}.png`) })
    await page.keyboard.press('Enter')
    assert.equal(await history.locator('details[open]').count(), 0)

    const input = page.locator('.xterm-helper-textarea')
    await input.focus()
    await history
      .getByText('• 已找到文档，正在确认成员的工作状态。')
      .evaluate((element: HTMLElement) => {
        const range = document.createRange()
        range.selectNodeContents(element)
        document.getSelection()?.removeAllRanges()
        document.getSelection()?.addRange(range)
        document.addEventListener(
          'copy',
          (event) => {
            document.body.dataset.copiedText = document.getSelection()?.toString()
            // Observe the real keyboard copy path without changing the user's clipboard.
            event.preventDefault()
          },
          { once: true }
        )
      })
    await page.keyboard.press('ControlOrMeta+c')
    assert.equal(
      await page.evaluate(() => document.body.dataset.copiedText),
      '• 已找到文档，正在确认成员的工作状态。'
    )
    await page.evaluate(() => document.getSelection()?.removeAllRanges())
    const ascii = `QA-input-${size.width}`
    const chinese = `中文输入-${size.width}`
    await page.keyboard.type(ascii)
    await page.keyboard.press('Enter')
    await history.getByText(`• 收到：${ascii}`).waitFor({ state: 'visible' })
    await input.focus()
    await input.evaluate((element: HTMLTextAreaElement, text: string) => {
      element.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true }))
      element.dispatchEvent(new CompositionEvent('compositionend', { data: text, bubbles: true }))
    }, chinese)
    // Native composition releases its key filter on the next browser task.
    await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
    await page.keyboard.press('Enter')
    await history.getByText(`• 收到：${chinese}`).waitFor({ state: 'visible' })
    assert.equal(await history.locator('details[open]').count(), 0)
    assert.ok(server.store.getLiveRun(run.runId).output.includes(ascii))
    assert.ok(server.store.getLiveRun(run.runId).output.includes(chinese))
    await summary.focus()
    await page.keyboard.press('Enter')
    await page.setViewportSize({ width: size.width - 30, height: size.height - 40 })
    await history.waitFor({ state: 'visible' })
    assert.equal(await history.locator('details[open]').count(), 1)
    await page.evaluate(
      async (url: string) => {
        const { applyUiTheme } = await import(/* @vite-ignore */ url)
        applyUiTheme('light')
      },
      `/@fs/${resolve('web/src/theme.ts').replaceAll('\\', '/')}`
    )
    await page.screenshot({ path: join(directory, `light-${size.width}.png`) })
    await context.close()
  }
  assert.deepEqual(errors, [])
  console.log(
    JSON.stringify({
      ok: true,
      screenshots: directory,
      checks: [
        'real PTY and WebSockets',
        'default collapsed during execution',
        'keyboard expand/collapse',
        'single native input',
        'ASCII and Chinese IME input',
        'copy without interrupting PTY',
        'expansion retained on resize and theme change',
        'desktop and narrow layout',
      ],
    })
  )
} finally {
  await browser.close()
  await vite.close()
  await server.close()
}
// This one-shot runner closes its servers above; exit remaining dev-tool workers.
process.exit(0)
