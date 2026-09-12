import { describe, expect, test } from 'vitest'

import { parseSendArgs, parseSkillDispatchArgs } from '../../src/cli/team.js'

describe('team send --skill parsing', () => {
  test.each([
    [
      ['Alice', '--skill', 'matt/tdd', 'implement', 'login'],
      { skillName: 'matt/tdd', task: 'implement login', workerName: 'Alice' },
    ],
    [
      ['--skill', 'matt/tdd', 'Alice', 'implement login'],
      { skillName: 'matt/tdd', task: 'implement login', workerName: 'Alice' },
    ],
    [
      ['Alice', 'implement', '--skill', 'matt/tdd', 'login'],
      { skillName: 'matt/tdd', task: 'implement login', workerName: 'Alice' },
    ],
  ])('accepts --skill in any supported flag order', (args, expected) => {
    expect(parseSendArgs(args as string[])).toEqual(expected)
  })

  test('supports a task beginning with a flag after --', () => {
    expect(parseSendArgs(['Alice', '--skill', 'matt/tdd', '--', '--fix', 'login'])).toEqual({
      skillName: 'matt/tdd',
      task: '--fix login',
      workerName: 'Alice',
    })
  })

  test('rejects a missing or repeated Skill value', () => {
    expect(() => parseSendArgs(['Alice', 'task', '--skill'])).toThrow('--skill requires a value')
    expect(() =>
      parseSendArgs(['Alice', '--skill', 'matt/tdd', '--skill', 'matt/tdd', 'task'])
    ).toThrow('--skill may be supplied only once')
  })
})

describe('team skill dispatch parsing', () => {
  test('accepts one dispatch id and preserves one positional path', () => {
    expect(parseSkillDispatchArgs(['--dispatch', 'dispatch-1', 'references/guide.md'])).toEqual({
      dispatchId: 'dispatch-1',
      positionals: ['references/guide.md'],
    })
  })

  test('rejects a repeated dispatch flag', () => {
    expect(() =>
      parseSkillDispatchArgs(['--dispatch', 'dispatch-1', '--dispatch', 'dispatch-2'])
    ).toThrow('Usage: team skill')
  })
})
