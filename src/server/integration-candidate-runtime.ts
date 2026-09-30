import { randomUUID } from 'node:crypto'
import { join, relative, resolve } from 'node:path'
import type { CodeReviewVersion } from '../shared/code-review.js'
import { sameCodeReviewVersion } from '../shared/code-review.js'
import type {
  IntegrationCandidate,
  IntegrationCandidateView,
} from '../shared/integration-candidate.js'
import type { AgentRuntime } from './agent-runtime-contract.js'
import type { CodeReviewRuntime } from './code-review-runtime.js'
import type { DispatchRecord } from './dispatch-ledger-store.js'
import type { GitWorkspaceService } from './git-workspace-service.js'
import { BadRequestError, ConflictError, HttpError } from './http-errors.js'
import {
  assertCandidatePath,
  candidateConflicts,
  candidatePatch,
  finishCandidateCheckout,
  finishCandidateGit,
  installCandidate,
  prepareCandidateGit,
} from './integration-candidate-git.js'
import { createIntegrationCandidateStore } from './integration-candidate-store.js'
import type { ResourceBudgetStore } from './resource-budget-store.js'
import { ResourceQueueWaitError, type ResourceStartQueue } from './resource-start-queue.js'
import type { Database } from './sqlite.js'
import type { VerificationRuntime } from './verification-runtime.js'
import { readVerificationVersion } from './verification-worktree.js'
import type { WorkerWorktreeRuntime } from './worker-worktree-runtime.js'
import { createWorkerWorktreeStore } from './worker-worktree-store.js'
import { validateReviewText } from './workspace-review.js'
import type { WorkspaceStore } from './workspace-store-contract.js'

export const createIntegrationCandidateRuntime = (input: {
  db: Database
  dataDir: string | null
  resources: ResourceBudgetStore
  resourceQueue: ResourceStartQueue
  reviews: CodeReviewRuntime
  verifications: VerificationRuntime
  worktrees: WorkerWorktreeRuntime
  workspaceStore: WorkspaceStore
  agentRuntime: AgentRuntime
  git: GitWorkspaceService
  getDispatch: (workspaceId: string, dispatchId: string) => DispatchRecord | undefined
}) => {
  const store = createIntegrationCandidateStore(input.db)
  const integrations = createWorkerWorktreeStore(input.db)
  const dataDirectory = () => {
    if (!input.dataDir)
      throw new ConflictError('Candidates require a persistent HiveTeam data directory.')
    return input.dataDir
  }
  const markIntegrated = (c: IntegrationCandidate) =>
    input.db.transaction(() => {
      store.save({ ...c, state: 'integrated', integrated_at: Date.now(), error: null })
      integrations.recordIntegration(c.source_verification_id, c.target_sha)
    })()
  for (const candidate of store.all())
    if (candidate.state === 'preparing')
      store.save({
        ...candidate,
        state: 'failed',
        error:
          'Preparation was interrupted. The candidate directory is retained. Inspect it and explicitly continue or prepare again.',
      })
  const requireCandidate = (workspaceId: string, dispatchId: string, id: string) => {
    const candidate = store.get(id)
    if (
      !candidate ||
      candidate.workspace_id !== workspaceId ||
      candidate.dispatch_id !== dispatchId
    )
      throw new HttpError(404, 'Integration candidate not found')
    return candidate
  }
  const operation = <T>(workspaceId: string, run: () => Promise<T>) =>
    input.worktrees.exclusive(workspaceId, () => input.git.withWorkspaceOperation(workspaceId, run))
  const treeFor = (c: IntegrationCandidate) => {
    const dispatch = input.getDispatch(c.workspace_id, c.dispatch_id)
    const tree = dispatch && input.worktrees.get(c.workspace_id, dispatch.toAgentId)
    if (!dispatch || !tree)
      throw new ConflictError('The candidate source worker is no longer available.')
    return { dispatch, tree }
  }
  const staleReason = async (c: IntegrationCandidate) => {
    const source = await input.reviews.view(c.workspace_id, c.dispatch_id)
    if (source.unavailable_reason || source.is_dirty || !source.version)
      return source.unavailable_reason ?? 'Commit source and target changes first.'
    if (
      source.version.repository_id !== c.repository_id ||
      source.version.source_sha !== c.source_sha ||
      source.version.report_revision !== c.report_revision
    )
      return 'Source code, report or repository changed. Prepare a new candidate.'
    if (
      source.version.base_sha !== c.target_sha &&
      !(c.state === 'integrated' && source.version.base_sha === c.candidate_sha)
    )
      return 'Target advanced. Prepare and verify a new candidate.'
    const verification = await input.verifications.view(c.workspace_id, c.dispatch_id)
    if (!verification.accepted || verification.runs[0]?.id !== c.source_verification_id)
      return 'Source acceptance changed. Accept the current source verification first.'
    const review = source.reviews[0]
    if (
      !review ||
      review.id !== c.source_review_id ||
      !review.accepted_at ||
      review.conclusion !== 'approve'
    )
      return 'Source review was superseded. Review the source again.'
    return null
  }
  const requireIdleTarget = (c: IntegrationCandidate) => {
    const { dispatch } = treeFor(c)
    const workspace = input.workspaceStore.getWorkspaceSnapshot(c.workspace_id)
    if (
      input.workspaceStore.getWorker(c.workspace_id, dispatch.toAgentId).pendingTaskCount ||
      workspace.agents.some(
        (agent) =>
          (agent.id === dispatch.toAgentId || !input.worktrees.get(c.workspace_id, agent.id)) &&
          input.agentRuntime.getActiveRunByAgentId(c.workspace_id, agent.id)
      )
    )
      throw new ConflictError('Stop source and shared-workspace agents before updating the target.')
    return workspace
  }
  const view = async (
    workspaceId: string,
    dispatchId: string,
    id: string
  ): Promise<IntegrationCandidateView> => {
    const c = requireCandidate(workspaceId, dispatchId, id)
    const stale = await staleReason(c)
    const verification = input.verifications.listCandidate(workspaceId, dispatchId, id)[0] ?? null
    let dirty = false
    let conflicts: string[] = []
    let patch = { patch: '', patch_truncated: false }
    if (c.candidate_sha || c.state === 'conflicted') {
      await assertCandidatePath(dataDirectory(), c, treeFor(c).tree.repoRoot)
      const version = await readVerificationVersion(c.checkout_path)
      dirty = version.isDirty || !!version.unavailableReason || version.headSha !== c.candidate_sha
      if (c.state === 'conflicted') conflicts = await candidateConflicts(c)
      else
        patch = await candidatePatch(
          c,
          relative(
            treeFor(c).tree.repoRoot,
            input.workspaceStore.getWorkspaceSnapshot(workspaceId).summary.path
          ).replaceAll('\\', '/') || null
        )
    }
    const eligible =
      c.state === 'prepared' &&
      !stale &&
      !dirty &&
      !!c.candidate_sha &&
      verification?.state === 'passed' &&
      verification.headSha === c.candidate_sha &&
      verification.reportRevision === c.report_revision &&
      c.review_sha === c.candidate_sha &&
      !!c.reviewed_at
    return {
      candidate: c,
      history: store.history(id),
      patch: patch.patch,
      truncated: patch.patch_truncated,
      conflicts,
      verification,
      can_accept: eligible && !c.accepted_at,
      can_integrate: eligible && !!c.accepted_at && c.verification_id === verification?.id,
      stale_reason:
        stale ??
        (dirty
          ? 'Candidate files changed or conflicts remain. Finish the candidate and verify again.'
          : null),
    }
  }
  input.resourceQueue.registerHandler(
    'integration_candidate',
    async (entry) => {
      const c = store.get(String(entry.payload.candidate_id))
      if (!c || c.state !== 'queued') throw new ConflictError('This candidate is no longer queued.')
      const reservation = input.resources.requireReserved(entry.reservation_id)
      try {
        try {
          input.worktrees.assertIdle(c.workspace_id)
        } catch (error) {
          if (!(error instanceof ConflictError)) throw error
          throw new ResourceQueueWaitError('waiting_for_git_operation')
        }
        await operation(c.workspace_id, async () => {
          const reason = await staleReason(c)
          if (reason) {
            store.save({ ...c, state: 'stale', error: reason })
            return
          }
          store.save({ ...c, state: 'preparing', error: null })
          try {
            const result = await prepareCandidateGit(c, treeFor(c).tree.repoRoot)
            store.save({
              ...c,
              state: result.conflicted ? 'conflicted' : 'prepared',
              candidate_sha: result.sha,
              error: null,
            })
          } catch (error) {
            store.save({
              ...c,
              state: 'failed',
              error: error instanceof Error ? error.message : String(error),
            })
            throw error
          }
        })
        return { runId: null }
      } finally {
        input.resources.release(reservation.id, { reason: 'spawn_not_started' })
      }
    },
    {
      ready: (entry) => {
        try {
          input.worktrees.assertIdle(entry.workspace_id)
        } catch (error) {
          if (!(error instanceof ConflictError)) throw error
          throw new ResourceQueueWaitError('waiting_for_git_operation')
        }
      },
      assertCancellable: (entry) => {
        if (entry.status === 'starting')
          throw new ConflictError(
            'Candidate preparation is already running. Wait for its result; the candidate directory is retained.'
          )
      },
      cancel: (entry) => {
        const c = store.get(String(entry.execution_key).slice('candidate:'.length))
        if (c?.state === 'queued')
          store.save({ ...c, state: 'abandoned', error: 'Cancelled before preparation.' })
      },
      failed: (entry, error) => {
        const c = store.get(entry.execution_key.slice('candidate:'.length))
        if (c?.state === 'queued' || c?.state === 'preparing')
          store.save({
            ...c,
            state: 'failed',
            error: error instanceof Error ? error.message : String(error),
          })
      },
    }
  )
  input.verifications.setCandidateSource(async (run) => {
    const subject = run.subject
    if (!subject)
      throw new ConflictError('Candidate verification requires a version-bound subject.')
    const c = requireCandidate(run.workspaceId, run.dispatchId, subject.candidate_id)
    if (
      c.state !== 'prepared' ||
      c.candidate_sha !== run.headSha ||
      subject.target_sha !== c.target_sha ||
      subject.source_sha !== c.source_sha ||
      subject.repository_id !== c.repository_id
    )
      throw new ConflictError('The candidate changed before verification could start.')
    const reason = await staleReason(c)
    if (reason) throw new ConflictError(reason)
    await assertCandidatePath(dataDirectory(), c, treeFor(c).tree.repoRoot)
    return c.checkout_path
  })
  const expected = (c: IntegrationCandidate, sha: string) => {
    if (!c.candidate_sha || c.candidate_sha !== sha)
      throw new ConflictError('Candidate version changed. Refresh it first.')
  }
  return {
    list: store.list,
    view,
    async prepare(workspaceId: string, dispatchId: string, version: CodeReviewVersion) {
      if (!input.dataDir)
        throw new ConflictError('Candidates require a persistent HiveTeam data directory.')
      const source = await input.reviews.view(workspaceId, dispatchId)
      const dispatch = input.getDispatch(workspaceId, dispatchId)
      const tree = dispatch && input.worktrees.get(workspaceId, dispatch.toAgentId)
      const verification = await input.verifications.view(workspaceId, dispatchId)
      const sourceVerification = verification.runs[0]
      const review = source.reviews[0]
      if (
        !dispatch ||
        !tree ||
        !sourceVerification ||
        source.is_dirty ||
        source.unavailable_reason ||
        !source.version ||
        !sameCodeReviewVersion(source.version, version) ||
        !verification.accepted ||
        !review?.accepted_at ||
        review.conclusion !== 'approve' ||
        review.source_sha !== version.source_sha ||
        review.report_revision !== version.report_revision ||
        review.repository_id !== version.repository_id
      )
        throw new ConflictError(
          'Refresh the source version and accept its current verification and approving review first.'
        )
      const duplicate = store
        .list(workspaceId, dispatchId)
        .find(
          (c) =>
            c.source_sha === version.source_sha &&
            c.target_sha === version.base_sha &&
            c.report_revision === version.report_revision &&
            ['queued', 'preparing', 'conflicted', 'prepared'].includes(c.state)
        )
      if (duplicate) return duplicate
      const id = randomUUID(),
        now = Date.now()
      const candidate: IntegrationCandidate = {
        id,
        workspace_id: workspaceId,
        dispatch_id: dispatchId,
        repository_id: version.repository_id,
        source_sha: version.source_sha,
        target_sha: version.base_sha,
        target_branch: tree.targetBranch,
        report_revision: version.report_revision,
        source_verification_id: sourceVerification.id,
        source_review_id: review.id,
        checkout_path: join(resolve(input.dataDir, 'integration-candidates'), id, 'checkout'),
        candidate_sha: null,
        state: 'queued',
        verification_id: null,
        review_sha: null,
        review_note: null,
        reviewed_at: null,
        accepted_at: null,
        integrated_at: null,
        error: null,
        created_at: now,
        updated_at: now,
      }
      input.db.transaction(() => {
        store.insert(candidate)
        input.resourceQueue.enqueue({
          workspaceId,
          agentId: dispatch.toAgentId,
          executionKey: `candidate:${id}`,
          kind: 'verification',
          source: 'integration_candidate',
          payload: { candidate_id: id },
        })
      })()
      return candidate
    },
    async continue(workspaceId: string, dispatchId: string, id: string) {
      return operation(workspaceId, async () => {
        const c = requireCandidate(workspaceId, dispatchId, id)
        if (!['conflicted', 'failed'].includes(c.state))
          throw new ConflictError('This candidate does not require conflict recovery.')
        const reason = await staleReason(c)
        if (reason) throw new ConflictError(reason)
        await assertCandidatePath(dataDirectory(), c, treeFor(c).tree.repoRoot)
        const reservation = input.resources.reserve({
          workspaceId,
          agentId: treeFor(c).dispatch.toAgentId,
          kind: 'verification',
          executionKey: `candidate-continue:${c.id}:${randomUUID()}`,
        })
        let result: Awaited<ReturnType<typeof finishCandidateGit>>
        try {
          result = await finishCandidateGit(c)
        } finally {
          input.resources.release(reservation.id, { reason: 'spawn_not_started' })
        }
        store.save({
          ...c,
          state: 'prepared',
          candidate_sha: result.sha,
          accepted_at: null,
          review_sha: null,
          reviewed_at: null,
          verification_id: null,
          error: null,
        })
        return view(workspaceId, dispatchId, id)
      })
    },
    async verify(
      workspaceId: string,
      dispatchId: string,
      id: string,
      sha: string,
      profileId: string
    ) {
      const c = requireCandidate(workspaceId, dispatchId, id)
      expected(c, sha)
      return input.verifications.start(workspaceId, dispatchId, {
        headSha: sha,
        reportRevision: c.report_revision,
        command: '',
        profileId,
        subject: {
          candidate_id: c.id,
          source_sha: c.source_sha,
          target_sha: c.target_sha,
          repository_id: c.repository_id,
        },
      })
    },
    async review(workspaceId: string, dispatchId: string, id: string, sha: string, note: string) {
      validateReviewText(note, 'note', 16000)
      if (!note.trim())
        throw new BadRequestError('A candidate review note of 1–16000 characters is required.')
      return operation(workspaceId, async () => {
        const current = await view(workspaceId, dispatchId, id),
          c = current.candidate
        expected(c, sha)
        if (c.state !== 'prepared' || current.stale_reason)
          throw new ConflictError(current.stale_reason ?? 'Prepare the candidate first.')
        store.save({
          ...c,
          review_sha: sha,
          review_note: note.trim(),
          reviewed_at: Date.now(),
          accepted_at: null,
        })
        return view(workspaceId, dispatchId, id)
      })
    },
    async accept(
      workspaceId: string,
      dispatchId: string,
      id: string,
      sha: string,
      verificationId: string
    ) {
      return operation(workspaceId, async () => {
        const current = await view(workspaceId, dispatchId, id),
          c = current.candidate
        expected(c, sha)
        if (
          (!current.can_accept && !current.can_integrate) ||
          current.verification?.id !== verificationId
        )
          throw new ConflictError(
            'Review and pass verification of this exact candidate before accepting it.'
          )
        store.save({
          ...c,
          verification_id: verificationId,
          accepted_at: c.accepted_at ?? Date.now(),
        })
        return view(workspaceId, dispatchId, id)
      })
    },
    async integrate(
      workspaceId: string,
      dispatchId: string,
      id: string,
      sha: string,
      targetSha: string,
      verificationId: string
    ) {
      return operation(workspaceId, async () => {
        const recovering = requireCandidate(workspaceId, dispatchId, id)
        if (recovering.state === 'integrating') {
          requireIdleTarget(recovering)
          expected(recovering, sha)
          if (recovering.target_sha !== targetSha || recovering.verification_id !== verificationId)
            throw new ConflictError('Integration recovery must use its original accepted version.')
          const target = await readVerificationVersion(
            input.workspaceStore.getWorkspaceSnapshot(workspaceId).summary.path
          )
          if (
            target.unavailableReason ||
            !('branch' in target) ||
            target.branch !== recovering.target_branch
          )
            throw new ConflictError(
              'Inspect the target checkout before retrying integration recovery.'
            )
          if (target.headSha === sha) {
            await finishCandidateCheckout(recovering, treeFor(recovering).tree.repoRoot)
            markIntegrated(recovering)
            return view(workspaceId, dispatchId, id)
          }
          if (target.headSha !== targetSha)
            throw new ConflictError(
              'Target changed during interrupted integration. Preserve the candidate and prepare again.'
            )
          if (target.isDirty)
            throw new ConflictError('Target files changed. Inspect them before recovery.')
          store.save({ ...recovering, state: 'prepared' })
        }
        const current = await view(workspaceId, dispatchId, id),
          c = current.candidate
        expected(c, sha)
        if (
          c.state === 'integrated' &&
          c.target_sha === targetSha &&
          c.verification_id === verificationId
        )
          return current
        if (
          !current.can_integrate ||
          c.target_sha !== targetSha ||
          c.verification_id !== verificationId
        )
          throw new ConflictError(
            current.stale_reason ?? 'Candidate acceptance is missing or stale.'
          )
        const { tree } = treeFor(c)
        const workspace = requireIdleTarget(c)
        const target = await readVerificationVersion(workspace.summary.path)
        if (
          target.headSha !== targetSha ||
          target.isDirty ||
          !('branch' in target) ||
          target.branch !== c.target_branch
        )
          throw new ConflictError('Target changed. Prepare a new candidate.')
        store.save({ ...c, state: 'integrating' })
        await installCandidate(c, tree.repoRoot)
        markIntegrated(c)
        return view(workspaceId, dispatchId, id)
      })
    },
    abandon(workspaceId: string, dispatchId: string, id: string) {
      const c = requireCandidate(workspaceId, dispatchId, id)
      if (
        input.verifications
          .listCandidate(workspaceId, dispatchId, id)
          .some((run) => run.state === 'running' || run.state === 'queued')
      )
        throw new ConflictError('Cancel candidate verification before abandoning this candidate.')
      if (['preparing', 'integrating', 'integrated'].includes(c.state))
        throw new ConflictError(
          'This candidate cannot be abandoned during preparation or after integration.'
        )
      for (const entry of input.resourceQueue.list(workspaceId))
        if (entry.execution_key === `candidate:${id}`) input.resourceQueue.cancel(entry.id)
      store.save({
        ...c,
        state: 'abandoned',
        error: 'Abandoned by local user. The candidate directory and evidence are retained.',
      })
      return requireCandidate(workspaceId, dispatchId, id)
    },
  }
}
export type IntegrationCandidateRuntime = ReturnType<typeof createIntegrationCandidateRuntime>
