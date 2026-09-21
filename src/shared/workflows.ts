export const workflowRunStatuses = ['running', 'completed', 'failed', 'stopped'] as const

export const workflowStepStatuses = [
  'queued',
  'running',
  'awaiting_review',
  'blocked',
  'completed',
  'failed',
  'stopped',
] as const

export type WorkflowRunStatus = (typeof workflowRunStatuses)[number]
export type WorkflowStepStatus = (typeof workflowStepStatuses)[number]

export const workflowConditions = [
  'report_success',
  'review_accepted',
  'verification_passed',
] as const
export type WorkflowCondition = (typeof workflowConditions)[number]
export interface WorkflowQuality {
  all_of: WorkflowCondition[]
}
export interface WorkflowResultVersion {
  dispatch_id: string
  report_revision: number
  attempt: number
  source_sha: string | null
  base_sha: string | null
  repository_id: string | null
}

/** The only executable workflow format. Code files remain discoverable metadata. */
export interface WorkflowStepDefinition {
  id: string
  needs: string[]
  task: string
  worker: string
  quality?: WorkflowQuality
}

export interface WorkflowCatalogItem {
  description: string
  id: string
  name: string
  path: string
  runnable: boolean
  updatedAt: number
  validationError: string | null
}

export interface WorkflowRunStep {
  quality?: WorkflowQuality
  waitingFor?: WorkflowCondition[]
  attempt?: number
  inputVersion?: string | null
  dependencyVersions?: Record<string, WorkflowResultVersion>
  resultVersion?: WorkflowResultVersion | null
  rerunPending?: boolean
  needsRerun?: boolean
  artifacts: string[]
  dispatchId: string | null
  error: string | null
  id: string
  needs: string[]
  reportText: string | null
  status: WorkflowStepStatus
  task: string
  worker: string
}

export interface WorkflowRun {
  createdAt: number
  endedAt: number | null
  error: string | null
  id: string
  name: string
  startedAt: number | null
  status: WorkflowRunStatus
  steps: WorkflowRunStep[]
  updatedAt: number
  workflowId: string
  workspaceId: string
}
