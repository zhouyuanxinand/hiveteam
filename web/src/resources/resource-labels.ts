import type { ExecutionKind, ResourceLimits } from '../../../src/shared/resource-budget.js'

export const resourceLimitLabels: Record<keyof ResourceLimits, [string, string]> = {
  max_running_total: ['全局执行上限', 'Global execution limit'],
  max_running_per_workspace: ['每工作区执行上限', 'Executions per workspace'],
  max_workers_per_workspace: ['每工作区 Worker 上限', 'Workers per workspace'],
  max_verification_per_workspace: ['每工作区验证上限', 'Verifications per workspace'],
}

const kindLabels: Record<ExecutionKind, [string, string]> = {
  orchestrator: ['Orchestrator', 'Orchestrator'],
  worker: ['Worker', 'Worker'],
  workspace_shell: ['工作区终端', 'Workspace shell'],
  verification: ['验证', 'Verification'],
}

export const executionKindLabel = (kind: ExecutionKind, zh: boolean) => kindLabels[kind][zh ? 0 : 1]

const stateLabels: Record<string, [string, string]> = {
  reserved: ['正在准备', 'Preparing'],
  spawn_pending: ['正在启动', 'Starting'],
  running: ['占用中', 'In use'],
  recovery_blocked: ['等待确认旧进程已退出', 'Previous process exit is unconfirmed'],
  queued: ['等待资源', 'Waiting for capacity'],
  starting: ['正在启动', 'Starting'],
  started: ['已启动', 'Started'],
  failed: ['启动失败', 'Failed'],
  cancelled: ['已取消', 'Cancelled'],
}
export const resourceStateLabel = (state: string, zh: boolean) =>
  stateLabels[state]?.[zh ? 0 : 1] ?? state

const reasonLabels: Record<string, [string, string]> = {
  global_limit: ['全局执行名额已满', 'Global execution capacity is full'],
  workspace_limit: ['该工作区执行名额已满', 'Workspace execution capacity is full'],
  verification_limit: ['该工作区验证名额已满', 'Workspace verification capacity is full'],
  recovery_pending: [
    '等待之前执行退出并完成清理',
    'Waiting for the previous execution to exit and finish cleanup',
  ],
  runtime_recovery: ['等待恢复调度', 'Waiting for recovery scheduling'],
  runtime_stopped: ['等待 Runtime 重启', 'Waiting for runtime restart'],
  waiting_for_resources: ['等待执行名额', 'Waiting for execution capacity'],
}

export const resourceReasonLabel = (reason: string, zh: boolean) =>
  reasonLabels[reason]?.[zh ? 0 : 1] ?? reason
