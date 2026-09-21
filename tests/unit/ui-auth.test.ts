import { describe, expect, test } from 'vitest'

import { createUiAuth } from '../../src/server/ui-auth.js'

describe('UI bootstrap lifecycle', () => {
  test('bootstrap is single-use and independent sessions survive another window opening', () => {
    const auth = createUiAuth()
    const bootstrap = auth.createBootstrap()
    expect(auth.validate(bootstrap)).toBe(false)
    const first = auth.exchangeBootstrap(bootstrap)
    const second = auth.exchangeBootstrap(auth.createBootstrap())
    expect(first).not.toBe(second)
    expect(auth.validate(first)).toBe(true)
    expect(auth.validate(second)).toBe(true)
    expect(() => auth.exchangeBootstrap(bootstrap)).toThrow('invalid or expired')
  })

  test('expires at 60 seconds and a restarted runtime accepts neither old bootstrap nor session', () => {
    let time = 1_000
    const auth = createUiAuth(() => time)
    const oldSession = auth.exchangeBootstrap(auth.createBootstrap())
    const expired = auth.createBootstrap()
    time += 60_000
    expect(() => auth.exchangeBootstrap(expired)).toThrow('invalid or expired')
    const valid = auth.createBootstrap()
    const restarted = createUiAuth()
    expect(restarted.validate(oldSession)).toBe(false)
    expect(() => restarted.exchangeBootstrap(valid)).toThrow('invalid or expired')
    expect(auth.validate(auth.getRemoteTunnelSecret())).toBe(false)
    expect(auth.validate(auth.getSupervisorToken())).toBe(false)
  })
})
