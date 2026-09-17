import { open, readdir, realpath } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import type { AgentConversation } from '../shared/agent-conversation.js'
import { parseAgentConversation } from './agent-conversation-parser.js'
import { isPathWithinRoot } from './fs-sandbox.js'

const MAX_LOG_BYTES = 2 * 1024 * 1024
const MAX_CACHE_ENTRIES = 24
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'

export const createAgentConversationReader = () => {
  const paths = new Map<string, string>()
  const snapshots = new Map<string, { fingerprint: string; value: AgentConversation }>()
  const inflight = new Map<string, Promise<AgentConversation>>()
  const locate = async (directory: string, id: string): Promise<string | undefined> => {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (
        entry.isFile() &&
        entry.name.startsWith('rollout-') &&
        entry.name.endsWith(`-${id}.jsonl`)
      )
        return join(directory, entry.name)
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue // Do not follow symlinks outside the session root.
      const found = await locate(join(directory, entry.name), id)
      if (found) return found
    }
    return undefined
  }
  const read = async (root: string, sessionId: string, cwd: string): Promise<AgentConversation> => {
    const pending: AgentConversation = {
      status: 'pending',
      session_id: sessionId,
      turns: [],
      truncated: false,
    }
    if (!/^[a-f0-9-]{36}$/i.test(sessionId)) return pending
    const key = JSON.stringify([root, sessionId, cwd])
    try {
      const sessionRoot = await realpath(join(root, 'sessions'))
      let path = paths.get(key)
      if (!path) path = await locate(sessionRoot, sessionId)
      if (!path) return pending
      path = await realpath(path)
      if (!isPathWithinRoot(sessionRoot, path)) return pending
      paths.set(key, path)
      while (paths.size > MAX_CACHE_ENTRIES) paths.delete(paths.keys().next().value as string)
      const file = await open(path, 'r')
      try {
        const stat = await file.stat()
        if (!stat.isFile()) return pending
        const fingerprint = `${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`
        const cached = snapshots.get(key)
        if (cached?.fingerprint === fingerprint) return cached.value
        const header = Buffer.alloc(Math.min(stat.size, 64 * 1024))
        const { bytesRead } = await file.read(header, 0, header.length, 0)
        const headerText = header.subarray(0, bytesRead).toString('utf8').split('\n')[0] ?? ''
        let meta: { type?: string; payload?: { id?: string; cwd?: string } }
        try {
          meta = JSON.parse(headerText)
        } catch (error) {
          if (error instanceof SyntaxError) return pending
          throw error
        }
        if (
          !meta ||
          meta.type !== 'session_meta' ||
          meta.payload?.id !== sessionId ||
          typeof meta.payload.cwd !== 'string' ||
          relative(resolve(meta.payload.cwd), resolve(cwd)) !== ''
        )
          return pending
        const start = Math.max(0, stat.size - MAX_LOG_BYTES)
        const buffer = Buffer.alloc(stat.size - start)
        const tail = await file.read(buffer, 0, buffer.length, start)
        const bytes = buffer.subarray(0, tail.bytesRead)
        const content = (start > 0 ? bytes.subarray(bytes.indexOf(10) + 1) : bytes).toString('utf8')
        const value: AgentConversation = {
          status: 'ready',
          session_id: sessionId,
          turns: parseAgentConversation(content),
          truncated: start > 0,
        }
        snapshots.delete(key)
        snapshots.set(key, { fingerprint, value })
        while (snapshots.size > MAX_CACHE_ENTRIES)
          snapshots.delete(snapshots.keys().next().value as string)
        return value
      } finally {
        await file.close()
      }
    } catch (error) {
      if (!missing(error)) throw error
      paths.delete(key)
      snapshots.delete(key)
      return pending
    }
  }
  return (root: string, sessionId: string, cwd: string) => {
    const key = JSON.stringify([root, sessionId, cwd])
    const running = inflight.get(key)
    if (running) return running
    const promise = read(root, sessionId, cwd).finally(() => inflight.delete(key))
    inflight.set(key, promise)
    return promise
  }
}
