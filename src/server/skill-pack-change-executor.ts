import { resolve } from 'node:path'

import type { SkillChangeReceipt } from '../shared/skill-packs.js'
import type { SkillPackChangeStore } from './skill-pack-change-store.js'
import type {
  InternalSkillChangeOperation,
  InternalSkillChangePlan,
  SkillChangeJournal,
} from './skill-pack-change-types.js'
import {
  applyFileState,
  applyLinkState,
  observeFileState,
  observeLinkState,
} from './skill-pack-filesystem.js'
import { SkillPackChangeError } from './skill-pack-operation-errors.js'
import { aggregateSkillPlanFingerprint } from './skill-pack-planner.js'

interface SkillPackChangeExecutorDependencies {
  changeStore: SkillPackChangeStore
  getWorkspacePath: (workspaceId: string) => string
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

const runOperation = async (
  workspacePath: string,
  operation: InternalSkillChangeOperation,
  direction: 'forward' | 'reverse'
) => {
  if (operation.kind === 'write_file') {
    const expected = direction === 'forward' ? operation.before : operation.after
    const next = direction === 'forward' ? operation.after : operation.before
    await applyFileState({ expected, next, path: operation.path, workspacePath })
    return
  }
  const expected = direction === 'forward' ? operation.before : operation.after
  const next = direction === 'forward' ? operation.after : operation.before
  await applyLinkState({ expected, next, path: operation.path, workspacePath })
}

const observeOperation = (operation: InternalSkillChangeOperation) =>
  operation.kind === 'write_file'
    ? observeFileState(operation.path)
    : observeLinkState(operation.path)

const reconcilePendingOperation = async (
  changeStore: SkillPackChangeStore,
  attemptId: string,
  plan: InternalSkillChangePlan,
  journal: SkillChangeJournal
) => {
  const index = journal.pendingOperationIndex
  if (index === null) return
  const operation = plan.internalOperations[index]
  if (!operation) {
    throw new SkillPackChangeError(
      'recovery_required',
      `Change journal references an unknown operation: ${index}`
    )
  }
  const observed = await observeOperation(operation)
  const appliedState = journal.direction === 'apply' ? operation.after : operation.before
  const untouchedState = journal.direction === 'apply' ? operation.before : operation.after
  if (observed.fingerprint === appliedState.fingerprint) {
    if (!journal.completedOperationIndexes.includes(index)) {
      journal.completedOperationIndexes.push(index)
    }
  } else if (observed.fingerprint !== untouchedState.fingerprint) {
    throw new SkillPackChangeError(
      'recovery_required',
      `Pending Skill Pack operation has an unknown filesystem state: ${operation.path}`
    )
  }
  journal.pendingOperationIndex = null
  changeStore.updateJournal(attemptId, journal)
}

const compensateOperation = async (
  changeStore: SkillPackChangeStore,
  attemptId: string,
  workspacePath: string,
  operation: InternalSkillChangeOperation,
  index: number,
  journal: SkillChangeJournal
) => {
  const observed = await observeOperation(operation)
  const expectedState = journal.direction === 'apply' ? operation.after : operation.before
  const compensatedState = journal.direction === 'apply' ? operation.before : operation.after
  if (observed.fingerprint === expectedState.fingerprint) {
    await runOperation(
      workspacePath,
      operation,
      journal.direction === 'apply' ? 'reverse' : 'forward'
    )
  } else if (observed.fingerprint !== compensatedState.fingerprint) {
    throw new SkillPackChangeError(
      'drift_detected',
      `Cannot safely compensate changed Skill Pack path: ${operation.path}`
    )
  }
  journal.completedOperationIndexes = journal.completedOperationIndexes.filter(
    (candidate) => candidate !== index
  )
  changeStore.updateJournal(attemptId, journal)
}

const verifyPlanFingerprint = async (plan: InternalSkillChangePlan) => {
  const observedFiles = await Promise.all(
    plan.observedFiles.map(async ({ path }) => ({ path, state: await observeFileState(path) }))
  )
  const observedLinks = await Promise.all(
    plan.observedLinks.map(async ({ path }) => ({ path, state: await observeLinkState(path) }))
  )
  const config = observedFiles[0]?.state
  const lock = observedFiles[1]?.state
  if (!config || !lock) {
    throw new SkillPackChangeError('path_unsafe', 'Change Plan is missing file observations')
  }
  const fingerprint = aggregateSkillPlanFingerprint(
    config,
    lock,
    new Map(observedLinks.map(({ path, state }) => [path, state]))
  )
  if (fingerprint !== plan.beforeFingerprint) {
    throw new SkillPackChangeError(
      'drift_detected',
      'Workspace Skill state changed after this plan was created'
    )
  }
}

const verifyUndoFingerprint = async (plan: InternalSkillChangePlan) => {
  const finalOperationByPath = new Map<string, InternalSkillChangeOperation>()
  for (const operation of plan.internalOperations) {
    finalOperationByPath.set(operation.path, operation)
  }
  for (const operation of finalOperationByPath.values()) {
    const observed = await observeOperation(operation)
    if (observed.fingerprint !== operation.after.fingerprint) {
      throw new SkillPackChangeError(
        'drift_detected',
        `Workspace Skill state changed after this receipt was applied: ${operation.path}`
      )
    }
  }
}

const placementOperations = (plan: InternalSkillChangePlan) =>
  plan.internalOperations.filter(
    (operation): operation is Extract<InternalSkillChangeOperation, { kind: 'placement' }> =>
      operation.kind === 'placement'
  )

export const createSkillPackChangeExecutor = ({
  changeStore,
  getWorkspacePath,
}: SkillPackChangeExecutorDependencies) => {
  const workspaceLocks = new Set<string>()

  const acquire = (workspaceId: string) => {
    if (workspaceLocks.has(workspaceId)) {
      throw new SkillPackChangeError(
        'mutation_conflict',
        'Another Skill Pack mutation is already running for this workspace'
      )
    }
    workspaceLocks.add(workspaceId)
  }

  const apply = async (workspaceId: string, planId: string): Promise<SkillChangeReceipt> => {
    acquire(workspaceId)
    try {
      if (changeStore.hasIncompleteAttempt(workspaceId)) {
        throw new SkillPackChangeError(
          'recovery_required',
          'An unfinished Skill Pack change must be recovered first'
        )
      }
      const plan = changeStore.getPlan(workspaceId, planId)
      if (!plan) throw new SkillPackChangeError('plan_not_found', 'Change Plan not found')
      if (changeStore.hasAppliedAttempt(plan.id)) {
        throw new SkillPackChangeError('plan_already_applied', 'Change Plan was already applied')
      }
      if (plan.expiresAt <= Date.now()) {
        throw new SkillPackChangeError('plan_expired', 'Change Plan has expired')
      }
      await verifyPlanFingerprint(plan)
      const attempt = changeStore.beginAttempt(plan)
      const workspacePath = resolve(getWorkspacePath(workspaceId))
      try {
        for (let index = 0; index < plan.internalOperations.length; index += 1) {
          const operation = plan.internalOperations[index]
          if (!operation) continue
          attempt.journal.pendingOperationIndex = index
          changeStore.updateJournal(attempt.attemptId, attempt.journal)
          await runOperation(workspacePath, operation, 'forward')
          attempt.journal.completedOperationIndexes.push(index)
          attempt.journal.pendingOperationIndex = null
          changeStore.updateJournal(attempt.attemptId, attempt.journal)
        }
        changeStore.commitApply(plan, attempt.attemptId, placementOperations(plan))
      } catch (error) {
        let rollbackError: unknown = null
        try {
          await reconcilePendingOperation(changeStore, attempt.attemptId, plan, attempt.journal)
        } catch (candidate) {
          rollbackError = candidate
        }
        if (!rollbackError) {
          for (const index of [...attempt.journal.completedOperationIndexes].reverse()) {
            const operation = plan.internalOperations[index]
            if (!operation) continue
            try {
              await compensateOperation(
                changeStore,
                attempt.attemptId,
                workspacePath,
                operation,
                index,
                attempt.journal
              )
            } catch (candidate) {
              rollbackError = candidate
              break
            }
          }
        }
        if (rollbackError) {
          changeStore.finishAttempt(
            attempt.attemptId,
            'recovery_required',
            `${errorMessage(error)}; rollback failed: ${errorMessage(rollbackError)}`
          )
          throw new SkillPackChangeError(
            'recovery_required',
            'Skill Pack apply failed and automatic rollback could not complete'
          )
        }
        changeStore.finishAttempt(attempt.attemptId, 'rolled_back', errorMessage(error))
        throw error
      }
      const receipt = changeStore.getReceipt(workspaceId, attempt.attemptId)
      if (!receipt) throw new Error('Applied Skill Pack receipt was not persisted')
      return receipt
    } finally {
      workspaceLocks.delete(workspaceId)
    }
  }

  const undo = async (workspaceId: string, receiptId: string): Promise<SkillChangeReceipt> => {
    acquire(workspaceId)
    try {
      if (changeStore.hasIncompleteAttempt(workspaceId)) {
        throw new SkillPackChangeError(
          'recovery_required',
          'An unfinished Skill Pack change must be recovered first'
        )
      }
      const receipt = changeStore.getReceipt(workspaceId, receiptId)
      if (!receipt) throw new SkillPackChangeError('receipt_not_found', 'Change Receipt not found')
      if (!receipt.undoAvailable) {
        throw new SkillPackChangeError(
          'receipt_not_undoable',
          'This Change Receipt is not eligible for Undo'
        )
      }
      const plan = changeStore.getPlan(workspaceId, receipt.planId)
      if (!plan) throw new SkillPackChangeError('plan_not_found', 'Change Plan not found')
      const workspacePath = resolve(getWorkspacePath(workspaceId))
      await verifyUndoFingerprint(plan)
      const journal = changeStore.beginUndo(workspaceId, receiptId)
      try {
        for (let index = plan.internalOperations.length - 1; index >= 0; index -= 1) {
          const operation = plan.internalOperations[index]
          if (!operation) continue
          journal.pendingOperationIndex = index
          changeStore.updateJournal(receiptId, journal)
          await runOperation(workspacePath, operation, 'reverse')
          journal.completedOperationIndexes.push(index)
          journal.pendingOperationIndex = null
          changeStore.updateJournal(receiptId, journal)
        }
        changeStore.commitUndo(plan, receiptId, placementOperations(plan))
      } catch (error) {
        let compensationError: unknown = null
        try {
          await reconcilePendingOperation(changeStore, receiptId, plan, journal)
        } catch (candidate) {
          compensationError = candidate
        }
        if (!compensationError) {
          for (const index of [...journal.completedOperationIndexes].sort(
            (left, right) => left - right
          )) {
            const operation = plan.internalOperations[index]
            if (!operation) continue
            try {
              await compensateOperation(
                changeStore,
                receiptId,
                workspacePath,
                operation,
                index,
                journal
              )
            } catch (candidate) {
              compensationError = candidate
              break
            }
          }
        }
        if (compensationError) {
          changeStore.finishAttempt(
            receiptId,
            'recovery_required',
            `${errorMessage(error)}; undo compensation failed: ${errorMessage(compensationError)}`
          )
          throw new SkillPackChangeError(
            'recovery_required',
            'Skill Pack Undo failed and automatic compensation could not complete'
          )
        }
        changeStore.finishAttempt(receiptId, 'applied', errorMessage(error))
        throw error
      }
      const updated = changeStore.getReceipt(workspaceId, receiptId)
      if (!updated) throw new Error('Undone Skill Pack receipt was not persisted')
      return updated
    } finally {
      workspaceLocks.delete(workspaceId)
    }
  }

  const recover = async () => {
    for (const incomplete of changeStore.listIncompleteAttempts()) {
      const { journal, plan, receipt } = incomplete
      if (!plan) {
        changeStore.finishAttempt(receipt.id, 'recovery_required', 'Change Plan is unavailable')
        continue
      }
      let workspacePath: string
      try {
        workspacePath = resolve(getWorkspacePath(receipt.workspaceId))
      } catch (error) {
        changeStore.finishAttempt(receipt.id, 'recovery_required', errorMessage(error))
        continue
      }
      try {
        await reconcilePendingOperation(changeStore, receipt.id, plan, journal)
        if (journal.direction === 'undo') {
          for (const index of [...journal.completedOperationIndexes].sort(
            (left, right) => left - right
          )) {
            const operation = plan.internalOperations[index]
            if (operation) {
              await compensateOperation(
                changeStore,
                receipt.id,
                workspacePath,
                operation,
                index,
                journal
              )
            }
          }
          changeStore.finishAttempt(receipt.id, 'applied', 'Interrupted Undo was compensated')
        } else {
          for (const index of [...journal.completedOperationIndexes].reverse()) {
            const operation = plan.internalOperations[index]
            if (operation) {
              await compensateOperation(
                changeStore,
                receipt.id,
                workspacePath,
                operation,
                index,
                journal
              )
            }
          }
          changeStore.finishAttempt(receipt.id, 'rolled_back', 'Interrupted Apply was rolled back')
        }
      } catch (error) {
        changeStore.finishAttempt(receipt.id, 'recovery_required', errorMessage(error))
      }
    }
  }

  return { apply, recover, undo }
}
