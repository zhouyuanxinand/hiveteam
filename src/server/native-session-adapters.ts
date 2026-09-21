import { randomUUID } from 'node:crypto'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import type { NativeSessionContext } from '../shared/native-session.js'
import type { SessionHarness } from '../shared/session-adapter.js'
import { canonicalSessionPath } from './native-session-context.js'
import { NativeSessionError } from './native-session-error.js'
import { runNativeSessionProcess } from './native-session-process.js'

type ProcessInput = Omit<Parameters<typeof runNativeSessionProcess>[0], 'exchange'>
export const parseNativeSessionId = (harness: SessionHarness, value: string) => {
  const id = value.trim()
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/u.test(id) ||
    (harness === 'grok' &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(id))
  )
    throw new NativeSessionError(
      'session_identity_mismatch',
      'The CLI returned an invalid native session ID. Allocation will not be repeated automatically.'
    )
  return id
}

export const grokSessionSummaryPath = (context: NativeSessionContext, id: string) => {
  parseNativeSessionId('grok', id)
  const encoded = encodeURIComponent(context.cwd).replace(
    /[!'()*]/gu,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  )
  if (encoded.length > 255)
    throw new NativeSessionError(
      'session_adapter_unverified',
      'This cwd requires Grok’s version-specific long-path encoding, which has not been verified. Move/rebind explicitly; Hive will not search other histories.'
    )
  return join(context.storage_root, 'sessions', encoded, id, 'summary.json')
}

export const checkGrokSession = async (context: NativeSessionContext, id: string) => {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(grokSessionSummaryPath(context, id), 'r')
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > 1048576)
      throw new NativeSessionError(
        'session_native_failure',
        'The bound Grok summary is not a supported session file.'
      )
    const value: unknown = JSON.parse(await handle.readFile('utf8'))
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      !('info' in value) ||
      !value.info ||
      typeof value.info !== 'object' ||
      Array.isArray(value.info)
    )
      throw new NativeSessionError(
        'session_native_failure',
        'The bound Grok summary has an unsupported structure. The original binding is retained.'
      )
    const info = value.info as Record<string, unknown>
    if (
      info.id !== id ||
      typeof info.cwd !== 'string' ||
      canonicalSessionPath(info.cwd) !== context.cwd
    )
      throw new NativeSessionError(
        'session_identity_mismatch',
        'The bound Grok summary belongs to a different native ID or cwd.'
      )
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR')
      throw new NativeSessionError(
        'session_missing',
        'The bound Grok session is missing. The original binding is retained.',
        { cause: error }
      )
    if (code === 'EACCES' || code === 'EPERM')
      throw new NativeSessionError(
        'session_access_denied',
        'The bound Grok session could not be read with the current permissions.',
        { cause: error }
      )
    if (error instanceof SyntaxError)
      throw new NativeSessionError(
        'session_native_failure',
        'The bound Grok summary is invalid JSON.',
        { cause: error }
      )
    throw error
  } finally {
    await handle?.close()
  }
}

export const checkCursorSession = async (input: ProcessInput, id: string) => {
  parseNativeSessionId('cursor', id)
  await runNativeSessionProcess({
    ...input,
    args: [...input.args, 'acp'],
    exchange: {
      initial: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: 'hive', version: '1' },
        },
      },
      receive(value, send) {
        if (!value || typeof value !== 'object')
          throw new NativeSessionError('session_native_failure', 'Malformed ACP response.')
        const message = value as {
          id?: unknown
          error?: { code?: unknown; message?: unknown }
          result?: unknown
          method?: string
        }
        if (message.method && message.id !== undefined) {
          // ACP initialization cannot approve tools or permissions, or read additional files.
          send({
            jsonrpc: '2.0',
            id: message.id,
            error: {
              code: -32601,
              message: 'Hive session inspection does not provide client tools.',
            },
          })
          return false
        }
        if (message.id !== 1 && message.id !== 2) return false
        if (message.error) {
          const code =
            message.error.code === -32000
              ? 'session_access_denied'
              : message.error.code === -32002
                ? 'session_missing'
                : 'session_native_failure'
          throw new NativeSessionError(
            code,
            `Cursor ACP session check failed (code ${String(message.error.code)}). The native binding is retained.`,
            { cause: message.error }
          )
        }
        if (!message.result || typeof message.result !== 'object')
          throw new NativeSessionError(
            'session_native_failure',
            'Cursor ACP did not return a structured result.'
          )
        if (message.id === 1) {
          const result = message.result as {
            protocolVersion?: number
            agentCapabilities?: { loadSession?: boolean }
          }
          if (result.protocolVersion !== 1 || result.agentCapabilities?.loadSession !== true)
            throw new NativeSessionError(
              'session_adapter_unverified',
              'This Cursor ACP does not advertise the supported protocol and exact session loading.'
            )
          send({
            jsonrpc: '2.0',
            id: 2,
            method: 'session/load',
            params: { sessionId: id, cwd: input.cwd, mcpServers: [] },
          })
          return false
        }
        return true
      },
    },
  })
}

export const allocateNativeSession = async (harness: SessionHarness, input: ProcessInput) => {
  if (harness === 'grok') return randomUUID()
  const result = await runNativeSessionProcess({ ...input, args: [...input.args, 'create-chat'] })
  if (result.exitCode !== 0)
    throw new NativeSessionError(
      'session_native_failure',
      `Cursor create-chat exited with code ${String(result.exitCode)}. Its allocation result is unknown.`
    )
  return parseNativeSessionId('cursor', result.stdout)
}

export const nativeSessionArgs = (
  harness: SessionHarness,
  id: string,
  isNew: boolean,
  base: string[],
  plugin: string
) => {
  parseNativeSessionId(harness, id)
  if (
    base.some((arg) =>
      /^(?:--resume|--continue|--session-id|--fork-session|--plugin-dir)(?:=|$)/u.test(arg)
    ) ||
    base.some((arg) => ['create-chat', 'acp'].includes(arg))
  )
    throw new NativeSessionError(
      'session_environment_mismatch',
      'Remove custom session-selection/plugin flags before using the managed native session adapter.'
    )
  return [
    ...base,
    '--plugin-dir',
    plugin,
    harness === 'grok' && isNew ? '--session-id' : '--resume',
    id,
  ]
}
