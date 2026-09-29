import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'

let previousDirectory

test('runtime data is isolated before each test', () => {
  previousDirectory = process.env.HIVE_DATA_DIR
  expect(previousDirectory).toBeTruthy()
  writeFileSync(join(previousDirectory, 'previous-test.txt'), 'private fixture')
  delete process.env.HIVE_DATA_DIR
})

test('clearing runtime configuration in one test cannot expose the next test to user data', () => {
  const directory = process.env.HIVE_DATA_DIR
  expect(directory).toBeTruthy()
  expect(directory).not.toBe(previousDirectory)
  expect(existsSync(join(directory, 'previous-test.txt'))).toBe(false)
})
