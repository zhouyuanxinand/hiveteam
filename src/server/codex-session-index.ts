import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'

interface Header {
  cwd: string
  id: string
}
interface Cached<T> {
  fingerprint: string
  value: T
}
const headers = new Map<string, Cached<Header | null>>()
const prefixes = new Map<string, Cached<string>>()
const MAX_HEADERS = 2_048
const MAX_PREFIXES = 64
const PREFIX_BYTES = 256 * 1024

const expectedReadError = (error: unknown) =>
  error instanceof SyntaxError ||
  (error instanceof Error &&
    'code' in error &&
    ['ENOENT', 'EACCES', 'EPERM'].includes(String(error.code)))

const fingerprint = (path: string) => {
  const stat = statSync(path, { bigint: true })
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
}
const cachedRead = <T>(
  cache: Map<string, Cached<T>>,
  limit: number,
  path: string,
  read: () => T
): T => {
  const version = fingerprint(path)
  const previous = cache.get(path)
  const value = previous?.fingerprint === version ? previous.value : read()
  cache.delete(path)
  cache.set(path, { fingerprint: version, value })
  while (cache.size > limit) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  return value
}

export const readCodexSessionFirstLine = (path: string, maxBytes = 64 * 1024): string | null => {
  const fd = openSync(path, 'r')
  try {
    const chunks: Buffer[] = []
    let position = 0
    while (position < maxBytes) {
      const buffer = Buffer.allocUnsafe(Math.min(4096, maxBytes - position))
      const count = readSync(fd, buffer, 0, buffer.length, position)
      if (count === 0) return Buffer.concat(chunks).toString('utf8').replace(/\r$/, '')
      const slice = buffer.subarray(0, count)
      const newline = slice.indexOf(0x0a)
      chunks.push(newline < 0 ? slice : slice.subarray(0, newline))
      if (newline >= 0) return Buffer.concat(chunks).toString('utf8').replace(/\r$/, '')
      position += count
    }
    return null
  } finally {
    closeSync(fd)
  }
}

const readHeader = (path: string) =>
  cachedRead(headers, MAX_HEADERS, path, () => {
    const line = readCodexSessionFirstLine(path)
    if (line === null) return null
    const parsed: unknown = JSON.parse(line)
    if (!parsed || typeof parsed !== 'object' || !('payload' in parsed)) return null
    const payload = parsed.payload
    if (!payload || typeof payload !== 'object') return null
    if (
      !('id' in payload) ||
      typeof payload.id !== 'string' ||
      !payload.id ||
      !('cwd' in payload) ||
      typeof payload.cwd !== 'string' ||
      !payload.cwd
    )
      return null
    return { id: payload.id, cwd: payload.cwd }
  })

const walk = (dir: string): string[] => {
  try {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) return walk(path)
      return entry.isFile() && /^rollout-.*\.jsonl$/i.test(entry.name) ? [path] : []
    })
  } catch (error) {
    if (expectedReadError(error)) return []
    throw error
  }
}

// Share bounded, stat-validated file data across members. Never cache an agent's
// identity verdict: each caller still checks its own cwd and binding marker.
export const listCodexSessionIds = (
  root: string,
  cwd: string,
  contentIncludes?: string | readonly string[],
  candidates?: ReadonlySet<string>
) => {
  const ids: string[] = []
  for (const path of walk(join(root, 'sessions'))) {
    try {
      const header = readHeader(path)
      if (!header || header.cwd !== cwd || (candidates && !candidates.has(header.id))) continue
      if (contentIncludes) {
        const prefix = cachedRead(prefixes, MAX_PREFIXES, path, () => {
          const fd = openSync(path, 'r')
          try {
            const buffer = Buffer.allocUnsafe(PREFIX_BYTES)
            const count = readSync(fd, buffer, 0, buffer.length, 0)
            return buffer.subarray(0, count).toString('utf8')
          } finally {
            closeSync(fd)
          }
        })
        const markers = typeof contentIncludes === 'string' ? [contentIncludes] : contentIncludes
        if (!markers.some((marker) => prefix.includes(marker))) continue
      }
      ids.push(header.id)
    } catch (error) {
      // A CLI can be writing an incomplete header, or remove a session during
      // enumeration. Other IO/programming failures must surface.
      if (!expectedReadError(error)) throw error
    }
  }
  return ids.sort((left, right) => left.localeCompare(right))
}
