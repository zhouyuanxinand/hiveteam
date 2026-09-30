import { existsSync, readFileSync } from 'node:fs'
import { expect, test } from 'vitest'

const readRequiredFile = (path) => {
  expect(existsSync(path)).toBe(true)
  return readFileSync(path, 'utf8')
}

test('root project config exists', () => {
  expect(existsSync('package.json')).toBe(true)
  expect(existsSync('tsconfig.json')).toBe(true)
  expect(existsSync('vitest.config.ts')).toBe(true)
})

test('public package metadata is ready for external users', () => {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8'))

  expect(packageJson.license).toBe('MIT')
  expect(packageJson.description).toBe(
    'HiveTeam runs Claude Code, Codex, Gemini, OpenCode, Qwen, and other CLI agents as a visible local team in your browser.'
  )
  expect(packageJson.keywords).toEqual(
    expect.arrayContaining(['ai-agents', 'cli', 'collaboration', 'multi-agent', 'workspace'])
  )
  expect(packageJson.files).toEqual(
    expect.arrayContaining(['CHANGELOG.md', 'LICENSE', 'README.md', 'README.zh.md', 'SECURITY.md'])
  )
})

test('public support documents describe license, safety, and release scope', () => {
  const changelog = readRequiredFile('CHANGELOG.md')
  const englishReadme = readRequiredFile('README.en.md')
  const license = readRequiredFile('LICENSE')
  const readme = readRequiredFile('README.md')
  const zhReadme = readRequiredFile('README.zh.md')
  const security = readRequiredFile('SECURITY.md')

  expect(changelog).toContain('2.1.19')
  expect(license).toContain('MIT License')
  expect(license).toContain('Permission is hereby granted')
  expect(readme).toContain('Quick Start')
  expect(readme).toContain('Platform Support')
  expect(readme).toContain('Safety Model')
  expect(readme).toContain('./README.zh.md')
  expect(zhReadme).toContain('快速开始')
  expect(zhReadme).toContain('平台支持')
  expect(zhReadme).toContain('安全模型')
  expect(englishReadme).toContain('[README.md](./README.md)')
  expect(englishReadme).toContain('[README.zh.md](./README.zh.md)')
  expect(security).toContain('Reporting a Vulnerability')
  expect(security).toContain('127.0.0.1')
})
