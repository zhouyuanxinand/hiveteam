import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { createDispatchLedgerStore } from '../../src/server/dispatch-ledger-store.js'
import Database from '../../src/server/sqlite.js'
import { createTeamMemoryDigestProvider } from '../../src/server/team-memory-digest.js'
import { memoryCorpus } from '../fixtures/memory-corpus.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const servers: Awaited<ReturnType<typeof startTestServer>>[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
})

test('labelled Chinese and English corpus Top-3 reaches 80% and beats the legacy LIKE baseline', async () => {
  const server = await startTestServer()
  servers.push(server)
  const workspace = server.store.createWorkspace(server.dataDir, 'Memory')
  const ids = new Map(
    memoryCorpus.map(([label, body]) => [
      label,
      server.store.memory.create(workspace.id, { kind: 'fact', body }).id,
    ])
  )
  for (let i = 0; i < 12; i++) {
    const entry = server.store.memory.create(workspace.id, {
      kind: 'fact',
      body: `Unrelated gardening ${i}`,
    })
    server.store.memory.update(workspace.id, entry.id, { pinned: i < 2 })
  }
  const db = new Database(join(server.dataDir, 'runtime.sqlite'))
  try {
    let hits = 0,
      baseline = 0
    for (const [label, , query] of memoryCorpus) {
      const expected = ids.get(label)
      const ranked = server.store.memory.list(workspace.id, { query, limit: 3 })
      if (ranked.some((entry) => entry.id === expected)) hits++
      const old = db
        .prepare(
          'SELECT id FROM memory_entries WHERE workspace_id=? AND LOWER(body) LIKE ? ORDER BY pinned DESC,updated_at DESC LIMIT 3'
        )
        .all(workspace.id, `%${query.toLowerCase()}%`) as Array<{ id: string }>
      if (old.some((entry) => entry.id === expected)) baseline++
    }
    expect(hits / memoryCorpus.length).toBeGreaterThanOrEqual(0.8)
    expect(hits).toBeGreaterThanOrEqual(baseline)
    console.log(
      JSON.stringify({
        corpus: 'memory-corpus-v1',
        queries: memoryCorpus.length,
        top3_hits: hits,
        like_top3_hits: baseline,
      })
    )
  } finally {
    db.close()
  }
})

test('HTTP history preserves prepared versions, budget exclusions and source staleness without widening scope', async () => {
  const server = await startTestServer()
  servers.push(server)
  const workspace = server.store.createWorkspace(server.dataDir, 'Memory')
  const other = server.store.createWorkspace(join(server.dataDir, 'other'), 'Other')
  const cookie = await getUiCookie(server.baseUrl)
  const source = server.store.memory.create(workspace.id, {
    kind: 'fact',
    body: 'source version one',
  })
  const entry = server.store.memory.create(workspace.id, {
    kind: 'decision',
    body: '中文登录验证规则 '.repeat(150),
  })
  server.store.memory.update(workspace.id, entry.id, { pinned: true })
  server.store.memory.create(other.id, { kind: 'fact', body: 'Private other workspace only' })
  const disabled = server.store.memory.create(workspace.id, {
    kind: 'fact',
    body: '中文登录禁用规则',
  })
  server.store.memory.update(workspace.id, disabled.id, { disabled: true })
  const db = new Database(join(server.dataDir, 'runtime.sqlite'))
  try {
    db.prepare(
      'INSERT INTO memory_sources(id,memory_id,source_type,source_id,text_hash,created_at) VALUES(?,?,?,?,?,?)'
    ).run(
      randomUUID(),
      entry.id,
      'memory',
      source.id,
      createHash('sha256')
        .update(JSON.stringify({ body: source.body, revision: 1 }))
        .digest('hex'),
      Date.now()
    )
    const budgetResponse = await fetch(
      `${server.baseUrl}/api/ui/workspaces/${workspace.id}/memory/budget`,
      {
        method: 'PUT',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ budget: 800 }),
      }
    )
    expect(budgetResponse.status).toBe(200)
    const provider = createTeamMemoryDigestProvider(server.store.memory, server.store.settings)
    const worker = server.store.addWorker(workspace.id, { name: 'History coder', role: 'coder' })
    const dispatch = createDispatchLedgerStore(db).createDispatch({
      workspaceId: workspace.id,
      toAgentId: worker.id,
      text: '中文登录',
    })
    const digest = provider.forDispatch(workspace.id, worker.id, '中文登录', dispatch.id)
    expect(digest.length).toBeLessThanOrEqual(800)
    expect(digest).toContain('hive-untrusted-data')
    expect(digest).toContain(entry.id)
    server.store.memory.update(workspace.id, entry.id, { body: 'new body' })
    server.store.memory.update(workspace.id, source.id, { body: 'source version two' })
    const response = await fetch(
      `${server.baseUrl}/api/ui/workspaces/${workspace.id}/memory/contexts?dispatch_id=${dispatch.id}`,
      { headers: { cookie } }
    )
    expect(response.status).toBe(200)
    const result = await response.json()
    const snapshot = result.contexts[0]
    expect(snapshot.digest).toBe(digest)
    expect(snapshot.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          memory_id: entry.id,
          selected: true,
          body: entry.body,
          memory_changed: true,
          sources: expect.arrayContaining([
            expect.objectContaining({ source_id: source.id, stale: true }),
          ]),
        }),
        expect.objectContaining({
          memory_id: disabled.id,
          selected: false,
          reasons: expect.arrayContaining(['disabled']),
        }),
      ])
    )
    expect(JSON.stringify(result)).not.toContain('Private other')
    expect(
      db.prepare('SELECT body FROM memory_revisions WHERE memory_id=? AND revision=2').get(entry.id)
    ).toEqual({ body: entry.body })
  } finally {
    db.close()
  }
})
