import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { parseSkillDirectory, parseSkillMarkdown } from '../../src/server/skill-file-parser.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { force: true, recursive: true })
})

describe('Skill file parser', () => {
  test('normalizes frontmatter and recognizes explicit-only Skills', () => {
    const parsed = parseSkillMarkdown(
      `---\nname: to-goal\ndescription: Build a verifiable goal.\ndisable-model-invocation: true\n---\nBody`,
      'fallback-name'
    )

    expect(parsed).toEqual({
      description: 'Build a verifiable goal.',
      explicitOnly: true,
      name: 'to-goal',
      validationErrors: [],
    })
  })

  test('keeps an invalid directory visible with actionable validation errors', () => {
    const parsed = parseSkillMarkdown('---\n---\nBody', 'Bad Skill Name')

    expect(parsed.name).toBe('Bad Skill Name')
    expect(parsed.validationErrors).toEqual(['missing_name', 'invalid_name', 'missing_description'])
  })

  test('reads a bounded Skill directory without executing its scripts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-skill-parser-'))
    tempDirs.push(root)
    const skillPath = join(root, 'tdd')
    mkdirSync(join(skillPath, 'scripts'), { recursive: true })
    writeFileSync(
      join(skillPath, 'SKILL.md'),
      '---\nname: tdd\ndescription: Test-driven development.\n---\nInstructions'
    )
    writeFileSync(join(skillPath, 'scripts', 'run.js'), 'throw new Error("must not run")')

    const parsed = await parseSkillDirectory({
      allowedRoots: [root],
      directoryName: 'tdd',
      rootId: 'codex-native:workspace:0',
      scope: 'workspace',
      skillPath,
    })

    expect(parsed).toMatchObject({
      conflict: false,
      containsScripts: true,
      description: 'Test-driven development.',
      explicitOnly: false,
      name: 'tdd',
      rootIds: ['codex-native:workspace:0'],
      sourceScopes: ['workspace'],
      validationErrors: [],
    })
    expect(parsed.instructionDigest).toMatch(/^sha256:[a-f0-9]{64}$/u)
  })

  test('refuses to read a Skill outside the declared scan boundaries', async () => {
    const allowedRoot = mkdtempSync(join(tmpdir(), 'hive-skill-allowed-'))
    const outsideRoot = mkdtempSync(join(tmpdir(), 'hive-skill-outside-'))
    tempDirs.push(allowedRoot, outsideRoot)
    writeFileSync(
      join(outsideRoot, 'SKILL.md'),
      '---\nname: outside\ndescription: Outside boundary.\n---\n'
    )

    const parsed = await parseSkillDirectory({
      allowedRoots: [allowedRoot],
      directoryName: 'outside',
      rootId: 'test-root',
      scope: 'workspace',
      skillPath: outsideRoot,
    })

    expect(parsed.instructionDigest).toBe('')
    expect(parsed.validationErrors).toEqual(['skill_path_outside_allowed_roots'])
  })
})
