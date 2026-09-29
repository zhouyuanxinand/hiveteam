import { describe, expect, test } from 'vitest'

import {
  generateRoleWorkerName,
  generateWorkerName,
  WORKER_NAME_POOL,
} from '../../src/shared/random-worker-name.js'

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

describe('role-based default member names', () => {
  test.each([
    ['coder', 'Coder'],
    ['reviewer', 'Reviewer'],
    ['tester', 'Tester'],
    ['custom', 'Custom'],
  ] as const)('expresses the %s role', (role, expected) => {
    expect(generateRoleWorkerName({ role })).toBe(expected)
  })
  test('uses the first available stable suffix without changing explicit template names', () => {
    expect(
      generateRoleWorkerName({
        role: 'reviewer',
        usedNames: new Set(['Reviewer', 'Reviewer 2', 'Reviewer 4']),
      })
    ).toBe('Reviewer 3')
    expect(
      generateRoleWorkerName({
        role: 'custom',
        baseName: '  文档作者  ',
        usedNames: new Set(['文档作者']),
      })
    ).toBe('文档作者 2')
    expect(generateRoleWorkerName({ role: 'tester', baseName: '  ' })).toBe('Tester')
  })
  test('keeps long template names within the API limit when suffixing and does not split emoji', () => {
    const baseName = `${'A'.repeat(61)}😀😀`
    expect(generateRoleWorkerName({ role: 'custom', baseName })).toBe(`${'A'.repeat(61)}😀`)
    expect(
      generateRoleWorkerName({
        role: 'custom',
        baseName,
        usedNames: new Set([`${'A'.repeat(61)}😀`]),
      })
    ).toBe(`${'A'.repeat(61)} 2`)
  })
})
