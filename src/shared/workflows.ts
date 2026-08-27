export const workflowRunStatuses = ['running', 'completed', 'failed', 'stopped'] as const

export const workflowStepStatuses = ['queued', 'running', 'completed', 'failed', 'stopped'] as const

export type WorkflowRunStatus = (typeof workflowRunStatuses)[number]
export type WorkflowStepStatus = (typeof workflowStepStatuses)[number]

/** The only executable workflow format. Code files remain discoverable metadata. */
export interface WorkflowStepDefinition {
  id: string
  needs: string[]
  task: string
  worker: string
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
