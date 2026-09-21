import { expect, test } from 'vitest'
import { createVerificationLogRedactor } from '../../src/server/verification-log-redactor.js'

test('redacts credentials, URL userinfo and multiline keys split at every process boundary', () => {
  const text =
    'start\ntoken=super-secret-value\nAuthorization: Bearer another-secret\nhttps://user:password@example.test/path\n-----BEGIN PRIVATE KEY-----\nkey-body\n-----END PRIVATE KEY-----\nTAIL_FAILURE\n'
  for (const size of [1, 2, 7, 63, 4096]) {
    const redactor = createVerificationLogRedactor()
    let result = ''
    for (let offset = 0; offset < text.length; offset += size)
      result += redactor.push(text.slice(offset, offset + size))
    result += redactor.finish()
    expect(result).toBe(
      'start\ntoken=[REDACTED]\nAuthorization: Bearer [REDACTED]\nhttps://[REDACTED]@example.test/path\n[REDACTED PRIVATE KEY]\nTAIL_FAILURE\n'
    )
  }
})

test('keeps complete large non-secret output and discards an unbounded credential value', () => {
  const redactor = createVerificationLogRedactor()
  const data = 'x'.repeat(300000)
  const output =
    redactor.push(data) +
    redactor.push('\npassword=') +
    redactor.push('secret'.repeat(50000)) +
    redactor.push('\nlast failure') +
    redactor.finish()
  expect(output).toBe(`${data}\npassword=[REDACTED]\nlast failure`)
})
