import { createExternalGoalBridge } from './external-goal-bridge.js'
import type { RuntimeStoreServices } from './runtime-store-helpers.js'
import { getOrchestratorId } from './workspace-store-support.js'

/** Wires durable external goals to the live Orchestrator terminal. */
export const createRuntimeStoreExternalGoalMethods = (services: RuntimeStoreServices) => {
  const bridge = createExternalGoalBridge({
    deliverToOrchestrator: (workspaceId, text) =>
      services.agentRuntime.deliverSystemMessageToAgent(
        workspaceId,
        getOrchestratorId(workspaceId),
        text,
        { requireActiveRun: true }
      ),
    getActiveRunByAgentId: (workspaceId, agentId) =>
      services.agentRuntime.getActiveRunByAgentId(workspaceId, agentId),
    getAgent: (workspaceId, agentId) => services.workspaceStore.getAgent(workspaceId, agentId),
    getWorkspaceSnapshot: (workspaceId) =>
      services.workspaceStore.getWorkspaceSnapshot(workspaceId),
    goalStore: services.externalGoalStore,
    listWorkers: (workspaceId) => services.workspaceStore.listWorkers(workspaceId),
    listWorkspaces: () => services.workspaceStore.listWorkspaces(),
  })

  return {
    cancelExternalGoal: bridge.cancelGoal,
    continueExternalGoal: bridge.continueGoal,
    inspectExternalGoalWorkspace: bridge.inspectWorkspace,
    listExternalGoalWorkspaces: bridge.listWorkspaces,
    reportExternalGoal: bridge.reportGoal,
    startExternalGoal: bridge.startGoal,
    waitExternalGoal: bridge.waitGoal,
  }
}
