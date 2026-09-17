import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { captureSessionIdWithCoordinator } from './claude-session-coordinator.js'
import { listCodexSessionIds } from './codex-session-index.js'

export { readCodexSessionFirstLine } from './codex-session-index.js'

export interface CodexSessionCaptureDiscriminator {
  contentIncludes?: string | readonly string[]
}
const getDefaultCodexHome = () => process.env.CODEX_HOME ?? join(homedir(), '.codex')
const expandHome = (path: string) =>
  path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(2)) : path

export const getCodexHome = (pattern?: string) => {
  if (!pattern) return getDefaultCodexHome()
  const markerIndex = pattern.replace(/\\/g, '/').indexOf('/sessions/')
  if (markerIndex === -1) return getDefaultCodexHome()
  const rawRoot = pattern.slice(0, markerIndex)
  if (rawRoot === '~/.codex' || rawRoot === '~/.codex/') return getDefaultCodexHome()
  return expandHome(rawRoot) || getDefaultCodexHome()
}

export const hasCodexSession = (
  cwd: string,
  sessionId: string,
  pattern?: string,
  discriminator?: CodexSessionCaptureDiscriminator
) =>
  listCodexSessionIds(
    getCodexHome(pattern),
    cwd,
    discriminator?.contentIncludes,
    new Set([sessionId])
  ).includes(sessionId)

export const snapshotCodexSessionIds = (
  cwd: string,
  codexHome = getDefaultCodexHome(),
  discriminator?: CodexSessionCaptureDiscriminator
) => new Set(listCodexSessionIds(codexHome, cwd, discriminator?.contentIncludes))

export const captureCodexSessionId = async (
  cwd: string,
  knownSessionIds: Set<string>,
  onCapture: (sessionId: string) => void,
  timeoutMs: number | null = 5000,
  intervalMs = 100,
  codexHome = getDefaultCodexHome(),
  discriminator?: CodexSessionCaptureDiscriminator,
  signal?: AbortSignal
) => {
  await captureSessionIdWithCoordinator({
    intervalMs,
    knownSessionIds,
    listSessionIds: () => listCodexSessionIds(codexHome, cwd),
    ...(discriminator?.contentIncludes
      ? {
          filterSessionIds: (sessionIds: string[]) =>
            listCodexSessionIds(codexHome, cwd, discriminator.contentIncludes, new Set(sessionIds)),
        }
      : {}),
    onCapture,
    projectKey: join(codexHome, 'sessions', cwd),
    timeoutMs,
    signal,
  })
}

export const isCodexSessionWriterActive = (sessionId: string, pattern?: string) =>
  existsSync(join(getCodexHome(pattern), 'thread-writer-locks', `${sessionId}.lock`))
export const codexSessionStoreExists = (codexHome = getDefaultCodexHome()) =>
  existsSync(join(codexHome, 'sessions'))
