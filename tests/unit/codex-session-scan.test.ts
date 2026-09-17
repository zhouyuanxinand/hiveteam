import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { hasCodexSession, snapshotCodexSessionIds } from '../../src/server/session-capture-codex.js'

const metrics = vi.hoisted(() => ({ bytes: 0 }))
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return {
    ...fs,
    readSync: (...args: Parameters<typeof fs.readSync>) => {
      const count = fs.readSync(...args)
      metrics.bytes += count
      return count
    },
  }
})
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'hive-session-scan-'))
  roots.push(root)
  const dir = join(root, 'sessions', '2026', '09', '17')
  mkdirSync(dir, { recursive: true })
  const cwd = join(root, '项目 space')
  const write = (directory: string, body: string, id: string = randomUUID()) => {
    const path = join(dir, `rollout-${id}.jsonl`)
    writeFileSync(path, `${JSON.stringify({ payload: { cwd: directory, id } })}\n${body}`)
    return { id, path }
  }
  return { root, dir, cwd, write }
}

test('filters other workspaces before reading their conversation prefixes', () => {
  const f = fixture()
  const marker = 'Hive session binding: workspace_id=one; agent_id=alice'
  const own = f.write(f.cwd, marker)
  for (let i = 0; i < 20; i++) f.write(`${f.cwd}-other`, `${'x'.repeat(256 * 1024)}${marker}`)
  metrics.bytes = 0
  expect(snapshotCodexSessionIds(f.cwd, f.root, { contentIncludes: marker })).toEqual(
    new Set([own.id])
  )
  expect(metrics.bytes).toBeLessThan(100 * 1024)
})

test('reuses unchanged headers and prefixes but invalidates append, replacement and deletion', () => {
  const f = fixture()
  const marker = 'Hive session binding: workspace_id=one; agent_id=alice'
  const own = f.write(f.cwd, '')
  const snapshot = () => snapshotCodexSessionIds(f.cwd, f.root, { contentIncludes: marker })
  expect(snapshot()).toEqual(new Set())
  appendFileSync(own.path, marker)
  expect(snapshot()).toEqual(new Set([own.id]))
  metrics.bytes = 0
  expect(snapshot()).toEqual(new Set([own.id]))
  expect(metrics.bytes).toBe(0)
  f.write(`${f.cwd}-other`, marker, own.id)
  expect(snapshot()).toEqual(new Set())
  unlinkSync(own.path)
  expect(
    hasCodexSession(f.cwd, own.id, join(f.root, 'sessions', '**', '*.jsonl'), {
      contentIncludes: marker,
    })
  ).toBe(false)
  f.write(f.cwd, marker, own.id)
  expect(snapshot()).toEqual(new Set([own.id]))
})

test('does not reuse another member in the same directory', () => {
  const f = fixture()
  const alice = f.write(f.cwd, 'agent_id=alice')
  const bob = f.write(f.cwd, 'agent_id=bob')
  expect(snapshotCodexSessionIds(f.cwd, f.root, { contentIncludes: 'agent_id=alice' })).toEqual(
    new Set([alice.id])
  )
  expect(snapshotCodexSessionIds(f.cwd, f.root, { contentIncludes: 'agent_id=bob' })).toEqual(
    new Set([bob.id])
  )
})

test('ignores incomplete or empty identities and observes a completed header later', () => {
  const f = fixture()
  f.write(f.cwd, 'agent_id=alice', '')
  const own = f.write(f.cwd, 'agent_id=alice')
  writeFileSync(own.path, '{"payload":')
  expect(snapshotCodexSessionIds(f.cwd, f.root)).toEqual(new Set())
  f.write(f.cwd, 'agent_id=alice', own.id)
  expect(snapshotCodexSessionIds(f.cwd, f.root)).toEqual(new Set([own.id]))
})
