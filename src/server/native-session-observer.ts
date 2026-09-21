import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionHarness } from '../shared/session-adapter.js'
import { canonicalSessionPath } from './native-session-context.js'
import { NativeSessionError } from './native-session-error.js'
import { buildCmdCommand } from './windows-command-line.js'

export const createNativeSessionObserver = async (
  harness: SessionHarness,
  nativeId: string,
  cwd: string
) => {
  const path = await mkdtemp(join(tmpdir(), 'hive-session-'))
  const events = join(path, 'identity.jsonl'),
    script = join(path, 'observe.cjs')
  try {
    await mkdir(join(path, 'hooks'))
    if (harness === 'cursor') await mkdir(join(path, '.cursor-plugin'))
    await writeFile(
      join(path, harness === 'cursor' ? '.cursor-plugin/plugin.json' : 'plugin.json'),
      JSON.stringify({
        name: 'hive-session-identity',
        version: '1.0.0',
        description: 'Observe native session identity for this launch.',
      }),
      { mode: 0o600 }
    )
    // Only identity fields leave stdin. Prompts, transcript contents and credentials are never copied.
    await writeFile(
      script,
      `const fs=require('node:fs');let data='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>{data+=s;if(data.length>16384)process.exit(1)});process.stdin.on('end',()=>{const e=JSON.parse(data);const h=${JSON.stringify(harness)};const event=h==='cursor'?e.hook_event_name:e.hookEventName;if(event!==(h==='cursor'?'sessionStart':'session_start'))process.exit(1);const value=h==='cursor'?{id:e.session_id,conversation_id:e.conversation_id,roots:e.workspace_roots}:{id:e.sessionId,cwd:e.cwd};fs.appendFileSync(${JSON.stringify(events)},JSON.stringify(value)+'\\n',{mode:0o600});});\n`,
      { mode: 0o600 }
    )
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
    const command =
      process.platform === 'win32'
        ? buildCmdCommand(process.execPath, [script])
        : `${quote(process.execPath)} ${quote(script)}`
    const hooks =
      harness === 'cursor'
        ? { sessionStart: [{ command }] }
        : { SessionStart: [{ hooks: [{ type: 'command', command }] }] }
    await writeFile(join(path, 'hooks/hooks.json'), JSON.stringify({ version: 1, hooks }), {
      mode: 0o600,
    })
  } catch (error) {
    await rm(path, { recursive: true, force: true })
    throw error
  }
  let closed = false
  const check = async () => {
    let contents: string
    try {
      contents = await readFile(events, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
    if (contents.length > 65536)
      throw new NativeSessionError(
        'session_identity_mismatch',
        'Native identity observer output exceeded its limit.'
      )
    const complete = contents.slice(0, contents.lastIndexOf('\n')).split('\n').filter(Boolean)
    for (const line of complete) {
      const value: unknown = JSON.parse(line)
      if (!value || typeof value !== 'object')
        throw new NativeSessionError(
          'session_identity_mismatch',
          'Native identity event is malformed.'
        )
      const event = value as Record<string, unknown>
      const matchingPath =
        harness === 'cursor'
          ? Array.isArray(event.roots) &&
            event.roots.length === 1 &&
            typeof event.roots[0] === 'string' &&
            canonicalSessionPath(event.roots[0]) === cwd
          : typeof event.cwd === 'string' && canonicalSessionPath(event.cwd) === cwd
      if (
        event.id !== nativeId ||
        (harness === 'cursor' && event.conversation_id !== nativeId) ||
        !matchingPath
      )
        throw new NativeSessionError(
          'session_identity_mismatch',
          'The native CLI reported a different session ID or workspace. Automatic input is blocked; the original binding is preserved.'
        )
    }
    return complete.length > 0
  }
  return {
    path,
    async wait(isAlive: () => boolean, signal?: AbortSignal) {
      const deadline = Date.now() + 10000
      while (!closed && isAlive() && !signal?.aborted && Date.now() < deadline) {
        if (await check()) return
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      throw new NativeSessionError(
        'session_identity_mismatch',
        'The native CLI did not prove its session identity before startup ended or timed out.'
      )
    },
    async close() {
      closed = true
      await rm(path, { recursive: true, force: true })
    },
  }
}
