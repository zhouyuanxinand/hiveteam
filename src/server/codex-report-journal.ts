import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { getCodexHome, readCodexSessionFirstLine } from './session-capture-codex.js'

export const assertReportSession = (file: string, sessionId: string, cwd: string) => {
  const header = JSON.parse(readCodexSessionFirstLine(file) ?? '{}')
  const normalize = (path: string) =>
    process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
  if (
    header.type !== 'session_meta' ||
    header.payload?.id !== sessionId ||
    typeof header.payload?.cwd !== 'string' ||
    normalize(header.payload.cwd) !== normalize(cwd)
  )
    throw new Error('The Codex report receipt journal does not match this Orchestrator session.')
}

export const reportJournalOffset = (file: string) => {
  const size = statSync(file).size
  const length = Math.min(size, 64 * 1024)
  const fd = openSync(file, 'r')
  try {
    const buffer = Buffer.allocUnsafe(length)
    const read = readSync(fd, buffer, 0, length, size - length)
    const newline = buffer.subarray(0, read).lastIndexOf(10)
    if (newline < 0)
      throw new Error('Codex journal has no complete recent record; report remains queued.')
    return size - length + newline + 1
  } finally {
    closeSync(fd)
  }
}

export const findReportSession = (pattern: string, sessionId: string, cwd: string): string => {
  const walk = (directory: string): string | undefined => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        const result = walk(path)
        if (result) return result
      } else if (entry.isFile() && entry.name.endsWith(`-${sessionId}.jsonl`)) {
        assertReportSession(path, sessionId, cwd)
        return path
      }
    }
    return undefined
  }
  const file = walk(join(getCodexHome(pattern), 'sessions'))
  if (!file)
    throw new Error('The bound Codex session journal is not available; report remains queued.')
  return file
}

const isUserReceipt = (line: string, marker: string) => {
  const record = JSON.parse(line)
  const payload = record.payload
  if (record.type === 'event_msg' && payload?.type === 'user_message')
    return typeof payload.message === 'string' && payload.message.includes(marker)
  return (
    record.type === 'response_item' &&
    payload?.role === 'user' &&
    Array.isArray(payload.content) &&
    payload.content.some(
      (part: { type?: string; text?: string }) =>
        (part.type === 'input_text' || part.type === 'text') &&
        typeof part.text === 'string' &&
        part.text.includes(marker)
    )
  )
}

/** Reads only new, complete JSONL records. Never acknowledges a PTY echo,
 * assistant/tool quotation, or a task-start event without the report itself. */
export const createReportJournalReader = (file: string, offset: number, marker: string) => {
  let position = offset
  let partial = Buffer.alloc(0)
  let found = false
  return () => {
    if (found) return { found: true, caughtUp: true }
    if (statSync(file).size < position)
      throw new Error('Codex session journal was truncated; report acceptance is uncertain.')
    const fd = openSync(file, 'r')
    try {
      // Bound work per poll even when another turn has produced megabytes.
      const buffer = Buffer.allocUnsafe(256 * 1024)
      const length = readSync(fd, buffer, 0, buffer.length, position)
      position += length
      partial = Buffer.concat([partial, buffer.subarray(0, length)])
      let end = partial.indexOf(10)
      while (end >= 0) {
        const line = partial.subarray(0, end).toString('utf8').trim()
        partial = partial.subarray(end + 1)
        if (line && isUserReceipt(line, marker)) {
          found = true
          return { found: true, caughtUp: true }
        }
        end = partial.indexOf(10)
      }
      if (partial.length > 8 * 1024 * 1024)
        throw new Error(
          'Codex journal record exceeds the receipt reader limit; report remains queued.'
        )
      return { found: false, caughtUp: position >= statSync(file).size && partial.length === 0 }
    } finally {
      closeSync(fd)
    }
  }
}
