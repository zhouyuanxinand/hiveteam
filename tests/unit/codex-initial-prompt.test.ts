import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import {
  prepareCodexInitialPrompt,
  usesCodexInitialPrompt,
} from '../../src/server/codex-initial-prompt.js'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const fixture = (filename = 'codex.exe') => {
  const cwd = mkdtempSync(join(tmpdir(), 'hive-initial-prompt-'))
  directories.push(cwd)
  const command = join(cwd, filename)
  writeFileSync(command, 'This fixture is resolved, never executed.')
  chmodSync(command, 0o700)
  return { command, cwd }
}

test('uses the native initial prompt only for a new Windows Codex preset session', () => {
  const config = { command: 'codex' }
  expect(usesCodexInitialPrompt(config, 'codex', 'win32')).toBe(true)
  expect(usesCodexInitialPrompt(config, 'codex', 'linux')).toBe(false)
  expect(usesCodexInitialPrompt(config, 'codex', 'darwin')).toBe(false)
  expect(usesCodexInitialPrompt(config, null, 'win32')).toBe(false)
  expect(usesCodexInitialPrompt(config, 'custom-codex', 'win32')).toBe(false)
  expect(
    usesCodexInitialPrompt({ ...config, presetAugmentationDisabled: true }, 'codex', 'win32')
  ).toBe(false)
  expect(
    usesCodexInitialPrompt({ ...config, resumedSessionId: 'existing-session' }, 'codex', 'win32')
  ).toBe(false)
})

test('rejects a shell wrapper without a native executable instead of returning a paste fallback', async () => {
  const { command, cwd } = fixture('codex.cmd')
  await expect(
    prepareCodexInitialPrompt({ command }, cwd, process.env, '完整\n启动说明')
  ).rejects.toThrow('shell wrapper cannot safely receive a multiline initial prompt')
})

test.each([
  { suffix: [] },
  { suffix: ['--'] },
])('preserves the complete prompt and one delimiter with args $suffix', async ({ suffix }) => {
  const { command, cwd } = fixture()
  const args = ['--no-daemon', '--model', 'selected-model', ...suffix]
  const text = '--not-an-option\n中文 🐝 "quoted" C:\\directory\\ $VAR %PATH% `literal`\n'
  const result = await prepareCodexInitialPrompt({ command, args }, cwd, process.env, text)
  expect(result).toEqual({
    command,
    args: ['--no-daemon', '--model', 'selected-model', '--', text],
  })
  expect(args).toEqual(['--no-daemon', '--model', 'selected-model', ...suffix])
})

test('rejects an oversized message in full instead of truncating its contract', async () => {
  const { command, cwd } = fixture()
  const text = `START\n${'中文'.repeat(20_000)}\nMANDATORY FINAL RULE`
  await expect(prepareCodexInitialPrompt({ command }, cwd, process.env, text)).rejects.toThrow(
    'Windows command-line limit'
  )
})

test.each([
  '"'.repeat(17_000),
  '\\'.repeat(17_000),
  '🐝'.repeat(17_000),
])('counts escaped quotes, trailing backslashes and UTF-16 code units in the command limit', async (text) => {
  const { command, cwd } = fixture()
  // Ordinary 17k characters fit; each of these has a larger native command
  // representation even though a character-count-only check would accept it.
  expect(
    (await prepareCodexInitialPrompt({ command }, cwd, process.env, 'x'.repeat(17_000))).args.at(-1)
  ).toHaveLength(17_000)
  await expect(prepareCodexInitialPrompt({ command }, cwd, process.env, text)).rejects.toThrow(
    'Windows command-line limit'
  )
})

test('includes pre-existing launch arguments when enforcing the total command-line limit', async () => {
  const { command, cwd } = fixture()
  const text = 'startup'.repeat(2000)
  const args = ['--model', 'x'.repeat(20_000)]
  await expect(
    prepareCodexInitialPrompt({ command, args }, cwd, process.env, text)
  ).rejects.toThrow('Windows command-line limit')
})
