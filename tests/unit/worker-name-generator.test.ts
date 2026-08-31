import { describe, expect, test } from 'vitest'

import { generateWorkerName, WORKER_NAME_POOL } from '../../src/shared/random-worker-name.js'

describe('worker name generator', () => {
  test('uses the complete shared 1,111-name catalog', () => {
    expect(WORKER_NAME_POOL).toHaveLength(1111)
    expect(new Set(WORKER_NAME_POOL).size).toBe(1111)
  })

  test('uses one pool regardless of display language or role at the caller', () => {
    expect(generateWorkerName({ nextUint32: () => 0 })).toBe(WORKER_NAME_POOL[0])
    expect(generateWorkerName({ nextUint32: () => 777 })).toBe(WORKER_NAME_POOL[777])
  })

  test('skips names already used in the current workspace', () => {
    const [first, second] = WORKER_NAME_POOL
    expect(first).toBeTruthy()
    expect(second).toBeTruthy()
    expect(
      generateWorkerName({
        nextUint32: () => 0,
        usedNames: new Set([first as string]),
      })
    ).toBe(second)
  })

  test('falls back to the catalog when every static name is occupied', () => {
    const name = generateWorkerName({
      nextUint32: () => 0,
      usedNames: new Set(WORKER_NAME_POOL),
    })
    expect(WORKER_NAME_POOL).toContain(name)
  })
})
