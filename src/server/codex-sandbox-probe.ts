import { randomUUID } from 'node:crypto'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ExecutionPolicyError } from './execution-policy-error.js'
import type { ManagedExecution } from './managed-execution.js'
import { runNativeSessionProcess } from './native-session-process.js'

/** Probe the local kernel/backend before any model-controlled process is launched. */
export const verifyCodexSandbox = async (input: {
  executable: string
  cliHome: string
  workspacePath: string
  scratchPath: string
  sourceWritable: boolean
  execution: ManagedExecution
  assertPolicy: () => Promise<void>
}) => {
  const id = randomUUID()
  const source = join(input.workspacePath, `.hive-permission-probe-${id}`)
  const outside = join(input.cliHome, `probe-private-${id}`)
  const script = join(input.scratchPath, `probe-${id}.cjs`)
  const report = join(input.scratchPath, `probe-${id}.json`)
  const ownedFiles: string[] = []
  const put = async (path: string, content: string) => {
    await writeFile(path, content, { flag: 'wx', mode: 0o600 })
    ownedFiles.push(path)
  }
  try {
    await put(source, 'synthetic source')
    await put(outside, 'synthetic private fixture')
    await put(
      script,
      `const fs=require('node:fs'),net=require('node:net');
const result={};const attempt=(name,run)=>{try{run();result[name]='allowed'}catch(error){result[name]=error.code}};
attempt('source_read',()=>fs.readFileSync(${JSON.stringify(source)}));
attempt('source_write',()=>fs.writeFileSync(${JSON.stringify(source)},'synthetic change'));
attempt('outside_read',()=>fs.readFileSync(${JSON.stringify(outside)}));
attempt('outside_write',()=>fs.writeFileSync(${JSON.stringify(outside)},'synthetic change'));
const socket=net.connect({host:'127.0.0.1',port:9});socket.on('connect',()=>finish('allowed'));socket.on('error',error=>finish(error.code));socket.setTimeout(1500,()=>finish('timeout'));
let finished=false;function finish(value){if(finished)return;finished=true;socket.destroy();result.network=value;fs.writeFileSync(${JSON.stringify(report)},JSON.stringify(result),{flag:'wx',mode:0o600});}
`
    )
    const { exitCode } = await runNativeSessionProcess({
      command: input.executable,
      args: ['sandbox', '--', process.execPath, script],
      cwd: input.workspacePath,
      env: {
        CODEX_HOME: input.cliHome,
        HOME: input.cliHome,
        TMPDIR: input.scratchPath,
      },
      execution: input.execution,
      assertPolicy: input.assertPolicy,
      timeoutMs: 10_000,
    })
    if (exitCode !== 0)
      throw new ExecutionPolicyError('The native sandbox could not start on this machine.', [
        'native_sandbox_preflight_failed',
      ])
    const observed: unknown = JSON.parse(await readFile(report, 'utf8'))
    ownedFiles.push(report)
    if (!observed || typeof observed !== 'object')
      throw new ExecutionPolicyError('The native sandbox returned no verifiable result.', [
        'native_sandbox_preflight_failed',
      ])
    const result = observed as Record<string, unknown>
    const denied = (value: unknown) =>
      value === 'ENOENT' || value === 'EACCES' || value === 'EROFS' || value === 'EPERM'
    if (
      result.source_read !== 'allowed' ||
      (input.sourceWritable ? result.source_write !== 'allowed' : !denied(result.source_write)) ||
      !denied(result.outside_read) ||
      !denied(result.outside_write) ||
      result.network !== 'EPERM'
    )
      throw new ExecutionPolicyError(
        'The native sandbox did not enforce the requested file and network restrictions.',
        ['native_sandbox_preflight_failed']
      )
  } finally {
    for (const path of ownedFiles)
      await unlink(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      })
  }
}
