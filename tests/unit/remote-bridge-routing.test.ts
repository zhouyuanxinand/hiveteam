import { describe, expect, test } from 'vitest'

import { classifyOpen, isCanonicalPath } from '../../src/shared/remote-bridge-routing.js'
import { StreamTransport } from '../../src/shared/remote-protocol.js'

describe('remote bridge routing', () => {
  test('allows only Hive API HTTP paths', () => {
    expect(
      classifyOpen({
        transport: StreamTransport.Http,
        http: { method: 'GET', path: '/api/workspaces', headers: [], hasBody: false },
      })
    ).toMatchObject({ ok: true })
    expect(
      classifyOpen({
        transport: StreamTransport.Http,
        http: { method: 'GET', path: '/index.html', headers: [], hasBody: false },
      })
    ).toEqual({ ok: false, reason: 'path_not_whitelisted' })
    expect(
      classifyOpen({
        transport: StreamTransport.Http,
        http: { method: 'GET', path: '/api/ui/session', headers: [], hasBody: false },
      })
    ).toEqual({ ok: false, reason: 'path_denied' })
    expect(
      classifyOpen({
        transport: StreamTransport.Http,
        http: { method: 'POST', path: '/api/remote/pairings', headers: [], hasBody: false },
      })
    ).toEqual({ ok: false, reason: 'path_denied' })
  })

  test('allows only terminal and task WebSocket paths', () => {
    expect(
      classifyOpen({
        transport: StreamTransport.Ws,
        ws: { path: '/ws/terminal/agent-1/io', query: [['clientId', 'phone-1']] },
      })
    ).toMatchObject({ ok: true, transport: 'ws' })
    expect(
      classifyOpen({
        transport: StreamTransport.Ws,
        ws: { path: '/ws/tasks/task-1' },
      })
    ).toMatchObject({ ok: true, transport: 'ws' })
    expect(
      classifyOpen({
        transport: StreamTransport.Ws,
        ws: { path: '/ws/terminal/agent-1/io?clientId=bad' },
      })
    ).toEqual({ ok: false, reason: 'path_not_canonical' })
    expect(
      classifyOpen({
        transport: StreamTransport.Ws,
        ws: { path: '/ws/other' },
      })
    ).toEqual({ ok: false, reason: 'path_not_whitelisted' })
  })

  test('rejects traversal and encoded path tricks', () => {
    expect(isCanonicalPath('/api/../secret')).toBe(false)
    expect(isCanonicalPath('/api/%2e%2e/secret')).toBe(false)
    expect(isCanonicalPath('//other-host/api')).toBe(false)
    expect(isCanonicalPath('/api/workspaces?limit=10')).toBe(true)
  })
})
