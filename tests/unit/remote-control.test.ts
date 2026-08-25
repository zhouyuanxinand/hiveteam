import { describe, expect, test } from 'vitest'

import {
  GW_CONTROL_PREFIX,
  HB_PING,
  HB_PONG,
  isAuthFatalCloseCode,
  RelayCloseCode,
} from '../../src/server/remote-control-constants.js'
import {
  HIVE_REMOTE_DEVICE_HEADER,
  HIVE_REMOTE_SECRET_HEADER,
  isTunnelDroppedRequestHeader,
  sanitizeTunnelResponseHeaders,
  stampLoopbackHeaders,
} from '../../src/server/remote-loopback-auth.js'

describe('remote gateway wire constants', () => {
  test('keeps gateway control and heartbeat values stable', () => {
    expect(GW_CONTROL_PREFIX).toBe('\0gw:')
    expect(HB_PING).toBe('hb:ping')
    expect(HB_PONG).toBe('hb:pong')
    expect(isAuthFatalCloseCode(RelayCloseCode.Unauthorized)).toBe(true)
    expect(isAuthFatalCloseCode(RelayCloseCode.Revoked)).toBe(true)
    expect(isAuthFatalCloseCode(RelayCloseCode.DaemonOffline)).toBe(false)
  })

  test('stamps only safe loopback headers and strips auth responses', () => {
    expect(isTunnelDroppedRequestHeader('Origin')).toBe(true)
    expect(isTunnelDroppedRequestHeader('x-forwarded-for')).toBe(true)
    expect(
      stampLoopbackHeaders(
        [
          ['Origin', 'https://attacker.invalid'],
          ['content-type', 'application/json'],
          ['x-hive-remote-secret', 'spoofed'],
        ],
        'boot-secret',
        'device-1'
      )
    ).toEqual({
      'content-type': 'application/json',
      [HIVE_REMOTE_SECRET_HEADER]: 'boot-secret',
      [HIVE_REMOTE_DEVICE_HEADER]: 'device-1',
    })
    expect(
      sanitizeTunnelResponseHeaders([
        ['set-cookie', 'hive_ui_token=secret'],
        ['x-hive-internal', 'secret'],
        ['content-type', 'application/json'],
      ])
    ).toEqual([['content-type', 'application/json']])
  })
})
