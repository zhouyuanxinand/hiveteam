import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import type { VerificationProfile } from '../shared/verification-profile.js'
import { buildCodexExecutionProfile } from './codex-execution-profile.js'
import { verifyCodexSandbox } from './codex-sandbox-probe.js'
import { readExecutionCliIdentity } from './execution-cli-identity.js'
import { createExecutionEnvironment } from './execution-environment.js'
import { readExecutionFilesystem } from './execution-filesystem.js'
import { ExecutionPolicyError } from './execution-policy-error.js'
import { createTesterCheckout } from './execution-tester-checkout.js'
import type { ManagedExecution } from './managed-execution.js'

/** Uses the same private Git snapshot and native CLI sandbox as stage 02 Tester runs. */
export const prepareVerificationEnvironment = async (input: {
  dataDir: string | null
  sourcePath: string
  headSha: string
  runId: string
  profile: VerificationProfile
  execution: ManagedExecution
}) => {
  if (
    input.profile.execution === 'restricted' &&
    (process.platform !== 'linux' || process.arch !== 'x64' || !input.dataDir)
  )
    throw new ExecutionPolicyError(
      'Restricted verification requires the verified Linux x64 Codex sandbox and a persistent data directory.',
      ['platform_sandbox_unverified']
    )
  const root = resolve(input.dataDir ?? tmpdir(), 'verification-worktrees', input.runId)
  const checkout = await createTesterCheckout({
    sourcePath: input.sourcePath,
    rootPath: root,
    headSha: input.headSha,
  })
  try {
    const scratch = join(root, 'scratch')
    await mkdir(scratch, { mode: 0o700 })
    const required = Object.fromEntries(
      input.profile.required_env.map((name) => [name, process.env[name]])
    )
    const env = createExecutionEnvironment({
      ...required,
      HOME: scratch,
      USERPROFILE: scratch,
      TMPDIR: scratch,
      TEMP: scratch,
      TMP: scratch,
    })
    if (input.profile.execution === 'trusted_unsafe') return { ...checkout, env, launcher: null }
    const identity = await readExecutionCliIdentity(
      { command: 'codex', args: [] },
      input.sourcePath
    )
    if (!identity.executable || identity.version !== 'codex-cli 0.155.1')
      throw new ExecutionPolicyError(
        'Install the verified Codex 0.155.1 native sandbox artifact for restricted verification.',
        ['cli_toolchain_unverified']
      )
    if (identity.executable.startsWith(`${resolve(input.sourcePath)}${sep}`))
      throw new ExecutionPolicyError('Verification cannot trust a CLI inside the mutable source.', [
        'cli_inside_mutable_workspace',
      ])
    const cliHome = join(root, 'policy')
    await mkdir(cliHome, { mode: 0o700 })
    const filesystem = await readExecutionFilesystem(checkout.checkoutRoot)
    await writeFile(
      join(cliHome, 'config.toml'),
      buildCodexExecutionProfile({
        workspacePath: checkout.checkoutRoot,
        cliHome,
        scratchPath: scratch,
        mailboxPath: join(root, 'unused-mailbox'),
        executableRoots: [dirname(await realpath(process.execPath)), dirname(identity.executable)],
        gitReadRoots: [...checkout.sourceReadRoots, ...filesystem.gitReadRoots],
        denyPaths: [cliHome, ...filesystem.denyPaths, ...checkout.sourceDeniedPaths],
        sourceWritable: true,
        toolPath: `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
        hiveEnv: Object.fromEntries(
          Object.entries(required).filter(
            (entry): entry is [string, string] => entry[1] !== undefined
          )
        ),
      }),
      { flag: 'wx', mode: 0o600 }
    )
    await verifyCodexSandbox({
      execution: input.execution,
      assertPolicy: async () => {
        const current = await readExecutionCliIdentity(
          { command: 'codex', args: [] },
          input.sourcePath
        )
        if (current.fingerprint !== identity.fingerprint)
          throw new ExecutionPolicyError(
            'The verification CLI changed during sandbox preparation.',
            ['launch_policy_changed']
          )
      },
      executable: identity.executable,
      cliHome,
      workspacePath: checkout.cwd,
      scratchPath: scratch,
      sourceWritable: true,
    })
    return { ...checkout, env: { ...env, CODEX_HOME: cliHome }, launcher: identity.executable }
  } catch (error) {
    await checkout.close()
    throw error
  }
}
