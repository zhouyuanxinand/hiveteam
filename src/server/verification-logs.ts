import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { VerificationLogPage } from '../shared/verification-profile.js'
import { BadRequestError, ConflictError } from './http-errors.js'

export const redactVerificationLog = (text: string) =>
  text
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI escape sequences from diagnostic output.
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(
      /((?:authorization\s*:\s*(?:bearer|basic)|(?:api[_-]?key|token|password|secret)\s*[=:])\s*)[^\s,;]+/giu,
      '$1[REDACTED]'
    )
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gu, '$1[REDACTED]@')
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/gu,
      '[REDACTED PRIVATE KEY]'
    )

export const createVerificationLogs = (dataDir: string | null) => {
  const root = resolve(dataDir ?? tmpdir(), 'verification-logs')
  const path = (id: string) => {
    if (!/^[a-f0-9-]{36}$/u.test(id)) throw new BadRequestError('Invalid verification log id')
    mkdirSync(root, { recursive: true, mode: 0o700 })
    if (lstatSync(root).isSymbolicLink() || realpathSync(root) !== root)
      throw new ConflictError('Verification log directory was redirected')
    return join(root, `${id}.log`)
  }
  return {
    writer(id: string) {
      const fd = openSync(
        path(id),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600
      )
      let bytes = 0
      return {
        append(text: string) {
          const buffer = Buffer.from(text)
          let offset = 0
          while (offset < buffer.length)
            offset += writeSync(fd, buffer, offset, buffer.length - offset)
          bytes += buffer.length
          return bytes
        },
        close() {
          closeSync(fd)
        },
      }
    },
    read(id: string, offset?: number, limit = 32768): VerificationLogPage {
      if (
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 65536 ||
        (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0))
      )
        throw new BadRequestError('Log offset must be nonnegative and limit must be 1–65536 bytes')
      let fd: number
      try {
        fd = openSync(path(id), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        return {
          text: '',
          offset: 0,
          next_offset: 0,
          total_bytes: 0,
          truncated: false,
          redacted: true,
        }
      }
      try {
        const info = fstatSync(fd)
        if (!info.isFile() || info.nlink !== 1)
          throw new ConflictError('Verification log is not a private regular file')
        const start = Math.min(offset ?? Math.max(0, info.size - limit), info.size)
        const buffer = Buffer.alloc(Math.min(limit, info.size - start))
        const length = readSync(fd, buffer, 0, buffer.length, start)
        return {
          text: redactVerificationLog(buffer.subarray(0, length).toString('utf8')),
          offset: start,
          next_offset: start + length,
          total_bytes: info.size,
          truncated: start > 0 || start + length < info.size,
          redacted: true,
        }
      } finally {
        closeSync(fd)
      }
    },
  }
}
