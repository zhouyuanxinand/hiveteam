import { describe, expect, test } from 'vitest'

import { runHiveRemoteCommand } from '../../src/cli/hive-remote.js'

const createConfig = (initial: Record<string, string | null> = {}) => {
  const values = new Map(Object.entries(initial))
  return {
    get: (key: string) => {
      const value = values.get(key)
      return value === undefined ? undefined : { value }
    },
    set: (key: string, value: string | null) => {
      values.set(key, value)
    },
    values,
  }
}

describe('hive remote CLI', () => {
  test('login stores the daemon token only after gateway approval', async () => {
    const config = createConfig()
    const output: string[] = []
    let polls = 0
    const code = await runHiveRemoteCommand(['login', '--gateway', 'https://gateway.test/'], {
      config,
      client: {
        requestCode: async () => ({ code: 'ABCD', expiresAt: 2000, pollIntervalMs: 1 }),
        exchangeToken: async () => {
          polls += 1
          return polls === 1 ? null : { daemonId: 'daemon-1', daemonToken: 'secret-token' }
        },
      },
      now: () => 1000,
      sleep: async () => {},
      log: (line) => output.push(line),
    })

    expect(code).toBe(0)
    expect(config.values.get('remote_gateway_url')).toBe('https://gateway.test/')
    expect(config.values.get('remote_daemon_id')).toBe('daemon-1')
    expect(config.values.get('remote_daemon_token')).toBe('secret-token')
    expect(config.values.get('remote_enabled')).toBe('true')
    expect(output.join('\n')).not.toContain('secret-token')
  })

  test('retries a transient gateway fetch failure after approval', async () => {
    const config = createConfig()
    const output: string[] = []
    let polls = 0
    const code = await runHiveRemoteCommand(['login'], {
      config,
      client: {
        requestCode: async () => ({ code: 'ABCD', expiresAt: 2000, pollIntervalMs: 1 }),
        exchangeToken: async () => {
          polls += 1
          if (polls === 1) throw new TypeError('fetch failed')
          return { daemonId: 'daemon-1', daemonToken: 'secret-token' }
        },
      },
      now: () => 1000,
      sleep: async () => {},
      log: (line) => output.push(line),
    })

    expect(code).toBe(0)
    expect(polls).toBe(2)
    expect(output.join('\n')).toContain('retrying until the code expires')
    expect(config.values.get('remote_enabled')).toBe('true')
  })

  test('status and logout never print or retain the token', async () => {
    const config = createConfig({
      remote_enabled: 'true',
      remote_gateway_url: 'https://gateway.test',
      remote_daemon_id: 'daemon-1',
      remote_daemon_token: 'secret-token',
    })
    const output: string[] = []
    expect(
      await runHiveRemoteCommand(['status'], { config, log: (line) => output.push(line) })
    ).toBe(0)
    expect(output.join('\n')).toContain('Logged in: yes')
    expect(output.join('\n')).not.toContain('secret-token')
    expect(
      await runHiveRemoteCommand(['logout'], { config, log: (line) => output.push(line) })
    ).toBe(0)
    expect(config.values.get('remote_enabled')).toBe('false')
    expect(config.values.get('remote_daemon_token')).toBeNull()
  })

  test('revoke reports unknown devices and revokes known devices', async () => {
    const revoked: string[] = []
    const errors: string[] = []
    const devices = {
      list: () => [],
      revoke: (id: string) => {
        if (id === 'device-1') {
          revoked.push(id)
          return true
        }
        return false
      },
    }
    expect(
      await runHiveRemoteCommand(['revoke', 'missing'], {
        deviceStore: devices,
        error: (line) => errors.push(line),
      })
    ).toBe(1)
    expect(
      await runHiveRemoteCommand(['revoke', 'device-1'], {
        deviceStore: devices,
        error: (line) => errors.push(line),
      })
    ).toBe(0)
    expect(revoked).toEqual(['device-1'])
    expect(errors).toEqual(['Unknown or already-revoked device: missing'])
  })
})
