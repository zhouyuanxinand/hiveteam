import { randomUUID } from 'node:crypto'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import {
  EXECUTION_POLICY_REVISION,
  type ExecutionPermissions,
  type ExecutionPolicySnapshot,
  type ExecutionPolicyUpdate,
  type ExecutionPolicyView,
} from '../shared/execution-policy.js'
import type { AgentSummary, WorkspaceSummary } from '../shared/types.js'
import { type buildAgentRunBootstrap, HIVE_BIN_DIR } from './agent-run-bootstrap.js'
import type { AgentLaunchConfigInput } from './agent-run-store.js'
import type { AgentSessionStorePort } from './agent-runtime-ports.js'
import { CodeReviewError } from './code-review-error.js'
import { buildCodexExecutionProfile } from './codex-execution-profile.js'
import { withCodexProcessIsolation } from './codex-process-isolation.js'
import { verifyCodexSandbox } from './codex-sandbox-probe.js'
import { readExecutionCliIdentity } from './execution-cli-identity.js'
import { readExecutionFilesystem } from './execution-filesystem.js'
import { createExecutionGitView } from './execution-git-view.js'
import {
  automaticTrustFingerprint,
  createAutomaticWorkerTrustStore,
} from './execution-policy-automatic-trust.js'
import { ExecutionPolicyError } from './execution-policy-error.js'
import { commitRestrictedWorkerChanges } from './execution-policy-git.js'
import { createExecutionPolicyStore } from './execution-policy-store.js'
import { createTesterCheckout } from './execution-tester-checkout.js'
import { BadRequestError, ConflictError, ForbiddenError } from './http-errors.js'
import type { ManagedExecution } from './managed-execution.js'
import type { SettingsStore } from './settings-store.js'
import type { Database } from './sqlite.js'
import { createTeamMailboxBroker } from './team-mailbox-broker.js'
import type { WorkerWorktreeRuntime } from './worker-worktree-runtime.js'

// Fixed artifact/tool matrix verified by tests/manual/codex-tools-acceptance.linux.json.

type Bootstrap = Omit<ReturnType<typeof buildAgentRunBootstrap>, 'startEnv'> & {
  startEnv: NodeJS.ProcessEnv
}
export interface PrepareExecutionInput {
  workspace: WorkspaceSummary
  agentId: string
  config: AgentLaunchConfigInput
  token: string
  execution: ManagedExecution
  hivePort: string
  isActive: () => boolean
  bootstrap: (config: AgentLaunchConfigInput, executionCwd?: string) => Bootstrap
}

interface ExecutionPolicyRuntimeInput {
  db: Database
  dataDir: string | null
  getWorkspace: (workspaceId: string) => WorkspaceSummary
  getWorkspacePaths: () => string[]
  getAgent: (workspaceId: string, agentId: string) => AgentSummary
  getConfig: (workspaceId: string, agentId: string) => AgentLaunchConfigInput | undefined
  getCommandPreset: SettingsStore['getCommandPreset']
  getActiveRun: (workspaceId: string, agentId: string) => { runId: string } | undefined | null
  sessionStore: AgentSessionStorePort
  worktrees: WorkerWorktreeRuntime
}

export const permittedCodexArgs = (args: string[]) => {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--no-alt-screen') continue
    if (arg === '--model' || arg === '-m') {
      if (args[++index] !== 'gpt-5.4') return false
      continue
    }
    return false
  }
  return true
}

export const createExecutionPolicyRuntime = (input: ExecutionPolicyRuntimeInput) => {
  const store = createExecutionPolicyStore(input.db)
  const automaticTrust = createAutomaticWorkerTrustStore(input.db)
  const brokers = new Map<string, { close: () => Promise<void>; deniedPaths: string[] }>()
  const configFor = (workspaceId: string, agentId: string) => {
    const config = input.getConfig(workspaceId, agentId)
    if (!config)
      throw new ConflictError('Configure a CLI before choosing its execution permissions.')
    return config
  }
  const inspect = async (
    workspaceId: string,
    agentId: string,
    config = configFor(workspaceId, agentId)
  ) => {
    const workspace = input.getWorkspace(workspaceId)
    const agent = input.getAgent(workspaceId, agentId)
    const cwd = await realpath(input.worktrees.path(workspace, agentId))
    const identity = await readExecutionCliIdentity(config, cwd)
    const preferenceFingerprint = automaticTrustFingerprint(
      config,
      identity,
      config.commandPresetId ? input.getCommandPreset(config.commandPresetId) : undefined
    )
    const privateHome = input.dataDir
      ? resolve(input.dataDir, 'execution-policies', agentId.replaceAll(':', '_'), 'codex-home')
      : null
    const grant = store.getGrant(workspaceId, agentId)
    const validGrant =
      grant?.cli_fingerprint === identity.fingerprint &&
      grant.cli_version === identity.version &&
      grant.policy_revision === EXECUTION_POLICY_REVISION
    const tree = input.worktrees.get(workspaceId, agentId)
    const missing: string[] = []
    if (!identity.available) missing.push('cli_unavailable')
    if (process.platform !== 'linux' || process.arch !== 'x64')
      missing.push('platform_sandbox_unverified')
    if (identity.version !== 'codex-cli 0.155.1') missing.push('cli_toolchain_unverified')
    if (
      identity.executable &&
      (identity.executable === cwd || identity.executable.startsWith(`${cwd}${sep}`))
    )
      missing.push('cli_inside_mutable_workspace')
    if (identity.executable && process.platform === 'linux') {
      const installationRoots = [
        identity.executable,
        await realpath(process.execPath),
        await realpath(dirname(HIVE_BIN_DIR)),
      ]
      const mutableRoots = [...input.getWorkspacePaths(), ...(input.dataDir ? [input.dataDir] : [])]
      for (const candidate of mutableRoots) {
        let root: string
        try {
          root = await realpath(candidate)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
          throw error
        }
        if (installationRoots.some((path) => path === root || path.startsWith(`${root}${sep}`))) {
          missing.push('runtime_installation_inside_workspace')
          break
        }
      }
    }
    if (!input.dataDir) missing.push('persistent_policy_directory_required')
    if (
      !permittedCodexArgs(config.args ?? []) ||
      (config.resumeArgsTemplate && config.resumeArgsTemplate !== 'resume {session_id}')
    )
      missing.push('custom_launch_flags_unverified')
    if (agent.role === 'custom') missing.push('custom_role_permissions_required')
    if ((agent.role === 'coder' || agent.role === 'tester') && !tree)
      missing.push('isolated_worker_worktree_required')
    const writable = agent.role === 'coder' || agent.role === 'tester'
    const requested: ExecutionPermissions = {
      read_roots: [cwd],
      write_roots: writable ? [cwd] : [],
      network: 'none',
      credentials: 'isolated_cli_home',
      approval: 'never',
      git_operations: agent.role === 'coder' ? ['read', 'controlled_commit'] : ['read'],
    }
    const actual: ExecutionPermissions | null = validGrant
      ? {
          read_roots: ['*'],
          write_roots: ['*'],
          network: 'unrestricted',
          credentials: 'trusted_cli',
          approval: 'cli_default',
          git_operations: ['unrestricted'],
        }
      : null
    const activeRun = input.getActiveRun(workspaceId, agentId)
    const active = activeRun ? store.forRun(activeRun.runId) : null
    const view: ExecutionPolicyView = {
      workspace_id: workspaceId,
      agent_id: agentId,
      role: agent.role,
      profile: validGrant ? 'trusted_unsafe' : 'restricted',
      policy_revision: EXECUTION_POLICY_REVISION,
      platform: process.platform,
      cli_id: identity.id,
      cli_version: identity.version,
      cli_fingerprint: identity.fingerprint,
      ...(identity.artifactSha256 ? { cli_artifact_sha256: identity.artifactSha256 } : {}),
      enforcement: validGrant ? 'trusted_unsafe' : missing.length ? 'unsupported' : 'pending',
      requested,
      actual,
      missing_capabilities: validGrant ? [] : missing,
      warnings: [
        'The native CLI process is trusted; restrictions cover its supported generated tools. The runtime and operating-system account are not isolated from each other.',
        ...(validGrant
          ? [
              'Explicit unsafe access permits files, commands, credentials and network reachable by the operating-system account.',
            ]
          : [
              'Restricted Codex uses a dedicated authentication home. Authenticate that home locally before use; existing account credentials are never copied.',
            ]),
        ...(grant && !validGrant
          ? [
              'The previous unsafe grant is stale. Review the current executable and launch settings before granting it again.',
            ]
          : []),
        ...(agent.role === 'tester'
          ? [
              'Tests may modify their isolated checkout and scratch files. They cannot commit or write the original workspace.',
            ]
          : []),
        ...(!validGrant && agent.role === 'orchestrator'
          ? [
              'Restricted Orchestrator source access is read-only. Delegate file edits to an isolated coder or ask the local user to update task files.',
            ]
          : []),
        ...(!validGrant && privateHome
          ? [
              `Restricted CLI authentication directory: ${privateHome}. Log in locally with CODEX_HOME set to this directory; HiveTeam never copies an existing account.`,
              'Restricted support is pinned to Linux x64, Codex 0.155.1 and gpt-5.4. The local sandbox backend is checked immediately before launch.',
              'Sensitive-path restrictions apply to current files. Existing Git history can still contain previously committed secrets.',
            ]
          : []),
      ],
      unsafe_grant: grant,
      automatic_worker: agent.role !== 'orchestrator' && Boolean(agent.spawnedByAgentId),
      automatic_worker_trust_configured: automaticTrust.configured(config.commandPresetId),
      trust_automatic_workers: automaticTrust.matches(
        config.commandPresetId,
        preferenceFingerprint
      ),
      active_policy: active
        ? {
            policy_id: active.policy_id,
            created_at: active.created_at,
            profile: active.profile,
            enforcement: active.enforcement,
            actual: active.actual,
            cli_version: active.cli_version,
            policy_revision: active.policy_revision,
            ...(active.checkout_head_sha ? { checkout_head_sha: active.checkout_head_sha } : {}),
          }
        : null,
      active_run_unverified: Boolean(activeRun && !active),
    }
    return { view, identity, workspace, cwd, agent, tree, config, preferenceFingerprint }
  }
  const preview = async (workspaceId: string, agentId: string) =>
    (await inspect(workspaceId, agentId)).view
  return {
    preview,
    assertReadOnlyReviewer(workspaceId: string, agentId: string) {
      const agent = input.getAgent(workspaceId, agentId)
      const run = input.getActiveRun(workspaceId, agentId)
      const policy = run ? store.forRun(run.runId) : null
      if (
        agent.role !== 'reviewer' ||
        !run ||
        !policy ||
        policy.profile !== 'restricted' ||
        policy.enforcement !== 'enforced' ||
        policy.role !== 'reviewer' ||
        policy.workspace_id !== workspaceId ||
        policy.agent_id !== agentId ||
        policy.requested.write_roots.length !== 0 ||
        !policy.actual ||
        policy.actual.write_roots.some((root) => {
          const source = resolve(policy.launch.cwd)
          const writable = resolve(root)
          return (
            root === '*' ||
            writable === source ||
            source.startsWith(`${writable}${sep}`) ||
            writable.startsWith(`${source}${sep}`)
          )
        }) ||
        policy.actual.git_operations.length !== 1 ||
        policy.actual.git_operations[0] !== 'read'
      )
        throw new CodeReviewError(
          'review_read_only_required',
          'Start a reviewer with an enforced read-only execution policy, or record a desktop review. Unverified and unrestricted runs cannot supply reviewer evidence.',
          403
        )
      return { runId: run.runId, policyId: policy.policy_id }
    },
    async update(workspaceId: string, agentId: string, value: ExecutionPolicyUpdate) {
      if (!value || (value.profile !== 'restricted' && value.profile !== 'trusted_unsafe'))
        throw new BadRequestError('Unknown execution profile')
      if (
        value.trust_automatic_workers !== undefined &&
        typeof value.trust_automatic_workers !== 'boolean'
      )
        throw new BadRequestError('trust_automatic_workers must be a boolean')
      const { view: current, config, preferenceFingerprint } = await inspect(workspaceId, agentId)
      if (
        value.expected_cli_fingerprint !== current.cli_fingerprint ||
        value.expected_cli_version !== current.cli_version ||
        value.policy_revision !== EXECUTION_POLICY_REVISION
      )
        throw new ConflictError(
          'CLI or policy changed. Refresh the execution policy and review it again.'
        )
      if (value.profile === 'trusted_unsafe' || value.trust_automatic_workers === true) {
        if (value.acknowledge_unsafe !== true)
          throw new BadRequestError(
            'Explicit acknowledgement is required for unrestricted execution.'
          )
      }
      if (value.trust_automatic_workers === true && !config.commandPresetId)
        throw new BadRequestError('Choose a command preset before setting automatic member trust.')
      if (value.trust_automatic_workers === true && !preferenceFingerprint)
        throw new BadRequestError(
          'The CLI installation cannot be verified for automatic member trust.'
        )
      input.db.transaction(() => {
        if (value.profile === 'trusted_unsafe')
          store.grant(workspaceId, agentId, {
            cli_fingerprint: current.cli_fingerprint,
            cli_version: current.cli_version,
            policy_revision: EXECUTION_POLICY_REVISION,
            granted_at: Date.now(),
          })
        else store.revoke(workspaceId, agentId)
        if (value.trust_automatic_workers !== undefined && config.commandPresetId)
          automaticTrust.set(
            workspaceId,
            agentId,
            config.commandPresetId,
            value.trust_automatic_workers ? preferenceFingerprint : null
          )
      })()
      return preview(workspaceId, agentId)
    },
    async authorizeAutomaticWorker(workspaceId: string, agentId: string, actorId: string) {
      const child = await inspect(workspaceId, agentId)
      if (
        !child.view.automatic_worker ||
        child.agent.spawnedByAgentId !== actorId ||
        child.agent.retiredAt !== undefined ||
        !child.config.commandPresetId
      )
        return
      const actor = await inspect(workspaceId, actorId)
      if (
        actor.agent.role !== 'orchestrator' ||
        actor.config.commandPresetId !== child.config.commandPresetId ||
        actor.preferenceFingerprint !== child.preferenceFingerprint ||
        !child.preferenceFingerprint ||
        !automaticTrust.matches(child.config.commandPresetId, child.preferenceFingerprint)
      )
        return
      // This is called once during admission, never by start/retry. A revoked
      // member therefore cannot recover its grant through an automatic restart.
      if (
        JSON.stringify(configFor(workspaceId, agentId)) !== JSON.stringify(child.config) ||
        JSON.stringify(configFor(workspaceId, actorId)) !== JSON.stringify(actor.config) ||
        automaticTrustFingerprint(
          child.config,
          child.identity,
          input.getCommandPreset(child.config.commandPresetId)
        ) !== child.preferenceFingerprint
      )
        throw new ConflictError('CLI configuration changed during automatic member admission.')
      const presetId = child.config.commandPresetId
      const fingerprint = child.preferenceFingerprint
      input.db.transaction(() => {
        if (store.hasDecision(workspaceId, agentId)) return
        store.grant(
          workspaceId,
          agentId,
          {
            cli_fingerprint: child.identity.fingerprint,
            cli_version: child.identity.version,
            policy_revision: EXECUTION_POLICY_REVISION,
            granted_at: Date.now(),
          },
          {
            preset_id: presetId,
            preference_fingerprint: fingerprint,
            spawned_by_agent_id: actorId,
          }
        )
      })()
    },
    async revoke(workspaceId: string, agentId: string) {
      input.getAgent(workspaceId, agentId)
      store.revoke(workspaceId, agentId)
      return preview(workspaceId, agentId)
    },
    async prepare(launch: PrepareExecutionInput) {
      const {
        view,
        identity,
        cwd: sourceCwd,
      } = await inspect(launch.workspace.id, launch.agentId, launch.config)
      if (view.enforcement === 'unsupported')
        throw new ExecutionPolicyError(
          'This CLI cannot enforce the requested execution policy. Review missing capabilities, or explicitly authorize this member and CLI for unsafe execution locally.',
          view.missing_capabilities
        )
      const assertCurrentPolicy = async () => {
        const current = await inspect(launch.workspace.id, launch.agentId)
        const grant = store.getGrant(launch.workspace.id, launch.agentId)
        if (
          current.identity.fingerprint !== identity.fingerprint ||
          current.cwd !== sourceCwd ||
          current.view.role !== view.role ||
          current.view.enforcement === 'unsupported' ||
          current.view.profile !== view.profile ||
          (view.profile === 'trusted_unsafe' &&
            (!grant ||
              grant.cli_fingerprint !== identity.fingerprint ||
              grant.policy_revision !== EXECUTION_POLICY_REVISION))
        )
          throw new ExecutionPolicyError(
            'Execution authorization or CLI changed while this member was preparing. Review and start it again.',
            ['launch_policy_changed']
          )
      }
      const policyId = randomUUID()
      let cwd = sourceCwd
      let bootstrap: Bootstrap
      let close = async () => {}
      const deniedPaths: string[] = []
      try {
        if (view.enforcement === 'trusted_unsafe') {
          bootstrap = launch.bootstrap(launch.config)
          if (identity.launcher)
            bootstrap.startConfig = { ...bootstrap.startConfig, command: identity.launcher }
        } else {
          if (!input.dataDir || !identity.executable)
            throw new ExecutionPolicyError('Missing trusted execution directory or executable', [
              'cli_unavailable',
            ])
          const policyRoot = resolve(
            input.dataDir,
            'execution-policies',
            launch.agentId.replaceAll(':', '_')
          )
          if (policyRoot === cwd || policyRoot.startsWith(`${cwd}${sep}`))
            throw new ExecutionPolicyError(
              'HiveTeam policy data must be outside the writable workspace.',
              ['policy_directory_overlaps_workspace']
            )
          const cliHome = join(policyRoot, 'codex-home')
          const scratch = join(policyRoot, 'scratch', policyId)
          await mkdir(cliHome, { recursive: true, mode: 0o700 })
          await mkdir(scratch, { recursive: true, mode: 0o700 })
          const tester =
            view.role === 'tester'
              ? await createTesterCheckout({
                  sourcePath: sourceCwd,
                  rootPath: join(policyRoot, 'tester'),
                })
              : null
          if (tester) {
            close = tester.close
            cwd = tester.cwd
            view.checkout_head_sha = tester.headSha
            view.requested = { ...view.requested, read_roots: [sourceCwd, cwd], write_roots: [cwd] }
            view.warnings.push(
              `This Tester run uses a fresh disposable checkout at commit ${tester.headSha}. The registered source checkout remains read-only.`
            )
            deniedPaths.push(...tester.sourceDeniedPaths)
          }
          const capture = {
            source: 'codex_session_jsonl_dir' as const,
            pattern: `${cliHome}/sessions/**/*.jsonl`,
          }
          const previousContext = input.sessionStore.getCaptureContext?.(
            launch.workspace.id,
            launch.agentId
          )
          if (
            previousContext &&
            (previousContext.capture.source !== capture.source ||
              previousContext.capture.pattern !== capture.pattern ||
              previousContext.cwd !== cwd ||
              previousContext.platform !== process.platform)
          )
            throw new ExecutionPolicyError(
              'The saved session belongs to a different CLI home or checkout. Restore that environment or deliberately create a new member; its conversation binding has been retained.',
              ['saved_session_policy_mismatch']
            )
          const broker = await createTeamMailboxBroker({
            root: join(policyRoot, 'mailboxes'),
            workspaceId: launch.workspace.id,
            agentId: launch.agentId,
            token: launch.token,
            hivePort: launch.hivePort,
            isActive: launch.isActive,
          })
          close = async () => {
            const results = await Promise.allSettled([
              broker.close(),
              ...(tester ? [tester.close()] : []),
            ])
            const errors = results
              .filter((result) => result.status === 'rejected')
              .map((result) => result.reason)
            if (errors.length)
              throw new AggregateError(errors, 'Execution policy resources could not be reclaimed.')
          }
          const filesystem = await readExecutionFilesystem(tester?.checkoutRoot ?? cwd)
          deniedPaths.push(cliHome, ...filesystem.denyPaths)
          const gitViewPath = join(policyRoot, 'git-views', policyId)
          const gitEnvironment =
            filesystem.gitDirectory && filesystem.commonDirectory
              ? await createExecutionGitView({
                  viewPath: gitViewPath,
                  gitDirectory: filesystem.gitDirectory,
                  commonDirectory: filesystem.commonDirectory,
                  workspacePath: tester?.checkoutRoot ?? cwd,
                })
              : {}
          const hiveEnv = {
            ...gitEnvironment,
            HIVE_PROJECT_ID: launch.workspace.id,
            HIVE_AGENT_ID: launch.agentId,
            HIVE_AGENT_TOKEN: 'mailbox',
            HIVE_PORT: launch.hivePort,
            HIVE_TEAM_MAILBOX: broker.path,
          }
          const toolPath = `${HIVE_BIN_DIR}:/usr/local/bin:/usr/bin:/bin`
          const executableRoots = [
            dirname(HIVE_BIN_DIR),
            join(dirname(dirname(HIVE_BIN_DIR)), 'package.json'),
            dirname(process.execPath),
            dirname(identity.executable),
          ]
          const profile = buildCodexExecutionProfile({
            workspacePath: cwd,
            cliHome,
            scratchPath: scratch,
            mailboxPath: broker.path,
            executableRoots,
            gitReadRoots: [
              ...(tester?.checkoutReadRoots ?? []),
              ...(tester?.sourceReadRoots ?? []),
              ...filesystem.gitReadRoots,
              ...(filesystem.gitDirectory ? [gitViewPath] : []),
            ],
            denyPaths: deniedPaths,
            sourceWritable: view.role === 'coder' || view.role === 'tester',
            toolPath,
            hiveEnv,
          })
          await writeFile(join(cliHome, 'config.toml'), profile, { mode: 0o600 })
          await verifyCodexSandbox({
            execution: launch.execution,
            assertPolicy: assertCurrentPolicy,
            executable: identity.executable,
            cliHome,
            workspacePath: cwd,
            scratchPath: scratch,
            sourceWritable: view.role === 'coder' || view.role === 'tester',
          })
          view.enforcement = 'enforced'
          bootstrap = launch.bootstrap(
            {
              ...launch.config,
              command: identity.executable,
              sessionIdCapture: capture,
              resumeArgsTemplate: 'resume {session_id}',
            },
            cwd
          )
          const originalArgs = launch.config.args ?? []
          const permittedFinalArgs = bootstrap.startConfig.resumedSessionId
            ? ['resume', bootstrap.startConfig.resumedSessionId, ...originalArgs]
            : originalArgs
          if (
            JSON.stringify(bootstrap.startConfig.args ?? []) !== JSON.stringify(permittedFinalArgs)
          )
            throw new ExecutionPolicyError(
              'The generated resume arguments conflict with the execution policy.',
              ['resume_flags_unverified']
            )
          bootstrap.startEnv = {
            ...bootstrap.startEnv,
            ...hiveEnv,
            CODEX_HOME: cliHome,
            HOME: cliHome,
            TMPDIR: scratch,
            PATH: toolPath,
          }
          view.actual = {
            ...view.requested,
            read_roots: [
              cwd,
              ':minimal',
              ...executableRoots,
              ...(tester?.checkoutReadRoots ?? []),
              ...(tester?.sourceReadRoots ?? []),
              ...filesystem.gitReadRoots,
              ...(filesystem.gitDirectory ? [gitViewPath] : []),
            ],
            deny_roots: deniedPaths,
            write_roots: [...view.requested.write_roots, scratch, join(broker.path, 'requests')],
          }
        }
        bootstrap.startConfig = await withCodexProcessIsolation(bootstrap.startConfig, identity, {
          cwd,
          env: bootstrap.startEnv,
          execution: launch.execution,
          assertPolicy: assertCurrentPolicy,
        })
        const snapshot: ExecutionPolicySnapshot = {
          ...view,
          active_policy: null,
          active_run_unverified: false,
          policy_id: policyId,
          created_at: Date.now(),
          launch: {
            command: bootstrap.startConfig.command,
            args: bootstrap.startConfig.args ?? [],
            cwd,
            environment_keys: Object.keys(bootstrap.startEnv).sort(),
          },
        }
        store.saveSnapshot(snapshot)
        brokers.set(policyId, { close, deniedPaths })
        return {
          ...bootstrap,
          cwd,
          policyId,
          sessionPolicy: snapshot,
          assertCurrentPolicy,
          bindRun: (runId: string) => store.bindRun(policyId, runId),
          close: async () => {
            const resource = brokers.get(policyId)
            if (!resource) return
            await resource.close()
            brokers.delete(policyId)
          },
        }
      } catch (error) {
        await close()
        throw error
      }
    },
    async commit(workspaceId: string, agentId: string, expectedHead: string, message: string) {
      const agent = input.getAgent(workspaceId, agentId)
      const run = input.getActiveRun(workspaceId, agentId)
      const policy = run ? store.forRun(run.runId) : null
      const tree = input.worktrees.get(workspaceId, agentId)
      if (
        agent.role !== 'coder' ||
        !tree ||
        !policy ||
        !policy.actual?.git_operations.some(
          (operation) => operation === 'controlled_commit' || operation === 'unrestricted'
        )
      )
        throw new ForbiddenError(
          'Only an authorized coder may commit its registered isolated branch.'
        )
      await input.worktrees.validate(tree)
      return commitRestrictedWorkerChanges({
        checkoutPath: tree.checkoutPath,
        repoRoot: tree.repoRoot,
        branch: tree.branch,
        expectedHead,
        message,
        deniedPaths: brokers.get(policy.policy_id)?.deniedPaths ?? [],
      })
    },
    async close() {
      await Promise.all([...brokers.values()].map((broker) => broker.close()))
      brokers.clear()
    },
  }
}

export type ExecutionPolicyRuntime = ReturnType<typeof createExecutionPolicyRuntime>
