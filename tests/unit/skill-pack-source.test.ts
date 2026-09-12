import { describe, expect, test } from 'vitest'

import {
  normalizeResolveSkillPackInput,
  SkillPackResolutionError,
} from '../../src/server/skill-pack-source.js'

describe('Skill Pack source normalization', () => {
  test('normalizes GitHub shorthand while retaining the requested ref', () => {
    expect(
      normalizeResolveSkillPackInput({
        packName: 'matt',
        source: {
          ref: 'feature/to-goal',
          repository: 'tt-a1i/matt-skills-with-to-goal.git',
          type: 'github',
        },
      })
    ).toEqual({
      packName: 'matt',
      source: {
        ref: 'feature/to-goal',
        repository: 'tt-a1i/matt-skills-with-to-goal',
        type: 'github',
      },
    })
  })

  test.each([
    'http://github.com/owner/repository.git',
    'https://token@github.com/owner/repository.git',
    'https://github.com/owner/repository.git?ref=main',
  ])('rejects unsafe Git URL %s', (url) => {
    expect(() =>
      normalizeResolveSkillPackInput({
        packName: 'pack',
        source: { ref: 'main', type: 'git', url },
      })
    ).toThrow(SkillPackResolutionError)
  })

  test('rejects refs that could be interpreted as command options', () => {
    expect(() =>
      normalizeResolveSkillPackInput({
        packName: 'pack',
        source: { ref: '--upload-pack=evil', repository: 'owner/repository', type: 'github' },
      })
    ).toThrow('Invalid Git ref')
  })
})
